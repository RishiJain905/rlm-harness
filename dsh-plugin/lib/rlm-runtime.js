// KV cache: run_code's description includes executionInstructions, which is fixed text (never per session or per
// call), so the tool header and the cached prompt prefix stay byte-identical. Sub-calls are separate requests.
//
// RLM mode's code runtime for DeepSeek Harness: a ctx.ptcRuntime provider whose programs run in a persistent Python
// REPL (../python/rlm_repl.py), one process per dsh agent (dsh's PTC executor passes the Agent as stateOwner).
// llm()/llm_batch() in the REPL are answered here through dsh's model service, on the agent's own route by default.
// Not a sandbox: sandboxMode is undefined, so the REPL runs with the user's file access (see the plan, §7).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { SEPARATOR, completeSubcall, subcallRoute, withThinking } from './subcalls.js'
import { MISSING_PREFIX, getBlob, putBlob } from './blobs.js'
import { effective } from './settings.js'
import { LLM_TOOL } from './tool-names.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPL = join(HERE, '..', 'python', 'rlm_repl.py')

export const DEFAULTS = Object.freeze({
  outputMaxChars: 8000, // what one run_code result shows (rlmh default profile: output_max_chars)
  maxParallelSubcalls: 8,
  maxSubcallsPerRun: 200,
  subcallMaxTokens: 16384,
  graceMs: 3000, // after an interrupt, how long the cell gets to stop before the REPL is killed
})

// Fixed text: it lands in run_code's tool description (KV cache note above).
export const INSTRUCTIONS = [
  'The program runs in a persistent Python REPL owned by this session: variables, functions and imports',
  'persist across run_code calls. Top-level await works. print() output is the program output, and a final',
  'bare expression is also shown. Each result is cut at a few thousand characters, so keep large data in variables',
  'instead of printing it. Tool results are dicts whose keys also read as attributes (r.lines or r["lines"]).',
  'Besides tools, the REPL has these built-in RLM functions (synchronous, no await). A sub-call is another model',
  'call that reads up to about 60,000 characters and answers briefly:',
  '- llm(prompt, over=None, schema=None, thinking=None) -> str: one sub-call.',
  '- llm_batch(prompts, shared=None, over=None, schema=None, thinking=None) -> list: sub-calls in parallel, in order.',
  '- segments(text, size=None) -> list: text cut into ~40,000-character slices at line ends (.id, .start, .end).',
  '  over=segment (or one per prompt) sends the segment first, byte for byte, so asking about it again is cached;',
  '  shared=text is sent first in every prompt of a batch.',
  '- schema= (str, int, bool, list[str], {"key": type}, ["yes", "no"] or a JSON Schema) returns parsed values.',
  '  thinking= ("off" to "max") sets how much a sub-call may think; "off" for lookups and extraction.',
  '- scan(text, question) -> the passages, quoted with offsets, that bear on the question, from every segment.',
  '- ask_files(files, question) -> {path: answer}: one sub-call per file (a glob or a list of paths).',
  '- rlm(task, context=None) -> str: a child run, a new agent with its own REPL and turns, for a job of several steps;',
  '  context (a str) is its input text, which it gets as a file. Use llm for one question about text you already have.',
  'Use these to read, classify, summarize or check large text piece by piece, then combine the results in Python,',
  'instead of printing the whole text into the conversation.',
].join('\n')

// D-29: the variables rlmh never passes to code it runs. Git's GIT_CONFIG_COUNT/KEY_n/VALUE_n set goes as a whole
// (D-62), because git refuses a partial set.
const KEY_LIKE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|HEADERS/i
const GIT_CONFIG = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i

export function replEnv(env = process.env) {
  const out = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || KEY_LIKE.test(name) || GIT_CONFIG.test(name)) continue
    out[name] = value
  }
  out.PYTHONUTF8 = '1'
  out.PYTHONIOENCODING = 'utf-8'
  delete out.PYTHONHOME
  delete out.PYTHONPATH
  return out
}

/** Candidate interpreters, most preferred first: the configured one, dsh desktop's bundled CPython, rlmh's, PATH. */
export function pythonCandidates(config = {}, env = process.env) {
  const list = []
  if (config.pythonBin) list.push(config.pythonBin)
  const win = process.platform === 'win32'
  const resources = process.resourcesPath ?? (win ? join(dirname(process.execPath), 'resources') : join(dirname(process.execPath), '..', 'Resources'))
  const bundled = join(resources, 'runtime', 'primary-runtime', 'dependencies', 'python')
  list.push(win ? join(bundled, 'python.exe') : join(bundled, 'bin', 'python3'))
  // An installed rlmh names its Python in <home>/engine/<version>/.installed.json (`python`, v0 step 10).
  const engines = join(env.RLMH_HOME || join(homedir(), '.rlm-harness'), 'engine')
  let versions = []
  try { versions = readdirSync(engines) } catch {}
  for (const version of versions) {
    try {
      const python = JSON.parse(readFileSync(join(engines, version, '.installed.json'), 'utf8')).python
      if (typeof python === 'string') list.push(python)
    } catch {}
  }
  list.push(...(win ? ['python', 'py'] : ['python3', 'python']))
  return list
}

/** The first candidate that runs CPython 3.10 or later, with its version; undefined when none does. */
export function findPython(config = {}, env = process.env) {
  for (const bin of pythonCandidates(config, env)) {
    if (bin.includes('/') || bin.includes('\\')) {
      if (!existsSync(bin)) continue
    }
    const args = bin === 'py' ? ['-3', '-I', '-c'] : ['-I', '-c']
    const probe = spawnSync(bin, [...args, 'import sys,platform;print(platform.python_implementation(),*sys.version_info[:2])'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true, env: replEnv(env),
    })
    const [impl, major, minor] = (probe.stdout ?? '').trim().split(/\s+/)
    if (probe.status === 0 && impl === 'CPython' && (+major > 3 || (+major === 3 && +minor >= 10))) {
      return { bin, prefix: bin === 'py' ? ['-3'] : [], version: `${major}.${minor}` }
    }
  }
  return undefined
}

export default class RlmPythonRuntime extends PtcRuntime {
  static inject = ['llm']

  constructor(ctx, config = {}) {
    super(ctx)
    this.baseConfig = { ...DEFAULTS, ...config }
    this.procs = new WeakMap() // state owner -> Repl
    this.everRan = new WeakSet() // owners whose REPL existed once (so a new one is a restart)
    this.all = new Set()
    this.python = undefined
    this.usage = { subcalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    ctx.effect(() => () => Promise.all([...this.all].map((r) => r.kill())))
  }

  /** The row's config with the user's live settings (lib/settings.js) on top, read on each use. */
  get config() { return effective(this.ctx, this.baseConfig) }

  get language() { return 'python' }
  get isolation() { return 'process' }
  get programFormat() { return 'repl' }
  get retainsState() { return true }
  get executionInstructions() { return INSTRUCTIONS }
  get timeout() { return { defaultMs: 600_000, maxMs: 1_800_000 } }

  resolve(request) {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs === undefined ? 600_000 : request.timeoutMs }
  }

  async release(owner) {
    const repl = this.procs.get(owner)
    this.procs.delete(owner)
    if (repl) await repl.kill()
  }

  async run(spec) {
    this.python ??= findPython(this.config) ?? null
    if (!this.python) {
      return { logs: [], error: { kind: 'worker-exit', message: 'RLM mode needs Python 3.10 or later, and none was found. Install DeepSeek Harness desktop (it includes Python) or Python 3.12, then start a new session.' } }
    }
    const owner = spec.stateOwner
    let repl = owner ? this.procs.get(owner) : undefined
    let restarted = false
    if (!repl || repl.dead) {
      restarted = owner !== undefined && this.everRan.has(owner)
      repl = new Repl(this)
      if (owner) { this.procs.set(owner, repl); this.everRan.add(owner) }
    }
    try {
      const result = await repl.run(spec)
      if (restarted) result.logs.unshift('[The REPL restarted: variables from earlier run_code calls are gone.]')
      return result
    } finally {
      if (!owner) await repl.kill()
    }
  }

  /** The route a direct sub-call uses (subcalls.js): the configured one, else the agent's model and effort. */
  subcallRoute(owner) {
    return subcallRoute(this.config, owner)
  }

  /**
   * A direct sub-call, used only when the session has no `llm` tool (lib/subcall-tool.js), for example a headless
   * profile without the RLM preset. Overridable in tests.
   */
  async complete(prompt, route, signal) {
    const { text, usage } = await completeSubcall(this.ctx.llm, prompt, route, signal, this.config.subcallMaxTokens)
    this.usage.subcalls += 1
    this.usage.inputTokens += usage.inputTokens
    this.usage.outputTokens += usage.outputTokens
    this.usage.cacheReadTokens += usage.cacheReadTokens
    return text
  }
}

/** A small counting semaphore for sub-call concurrency. */
class Gate {
  constructor(n) { this.free = Math.max(1, n); this.queue = [] }
  async take() {
    if (this.free > 0) { this.free--; return }
    await new Promise((res) => this.queue.push(res))
  }
  give() { const next = this.queue.shift(); if (next) next(); else this.free++ }
}

class Repl {
  constructor(runtime) {
    this.runtime = runtime
    this.dead = false
    this.pending = undefined
    this.gate = new Gate(runtime.config.maxParallelSubcalls)
    const { bin, prefix } = runtime.python
    this.child = spawn(bin, [...prefix, '-I', '-u', '-X', 'utf8', REPL], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: replEnv(),
    })
    runtime.all.add(this)
    this.stderr = ''
    this.child.stdin.on('error', () => {}) // a write after the child died: handled through 'exit'
    this.child.stderr.on('data', (b) => { this.stderr = (this.stderr + b.toString()).slice(-4000) })
    this.child.on('error', (e) => this.onExit(`could not start Python: ${e.message}`))
    this.child.on('exit', (code) => this.onExit(`Python exited with code ${code}`))
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onFrame(line))
  }

  onExit(why) {
    if (this.dead) return
    this.dead = true
    this.runtime.all.delete(this)
    this.pending?.finish({ logs: [], error: { kind: 'worker-exit', message: `${why}. ${this.stderr}`.trim() } })
  }

  send(frame) {
    if (this.dead || this.child.stdin.destroyed || !this.child.stdin.writable) return
    this.child.stdin.write(JSON.stringify(frame) + '\n')
  }

  kill() {
    if (this.dead) return Promise.resolve()
    return new Promise((res) => {
      this.child.once('exit', () => res())
      this.child.stdin.end()
      setTimeout(() => { if (!this.dead) this.child.kill() }, 1000).unref()
    })
  }

  run(spec) {
    const { graceMs, outputMaxChars } = this.runtime.config
    return new Promise((resolveRun) => {
      const subcalls = new AbortController() // stops this run's sub-calls on timeout, abort or exit
      let stopping
      const stop = (kind, message) => {
        if (stopping || !this.pending) return
        stopping = { kind, message }
        subcalls.abort(message)
        this.send({ t: 'interrupt' })
        setTimeout(() => {
          if (this.pending) { this.child.kill(); }
        }, graceMs).unref()
      }
      const timer = spec.timeoutMs ? setTimeout(() => stop('timeout', `run_code timed out after ${spec.timeoutMs} ms`), spec.timeoutMs) : undefined
      const onAbort = () => stop('abort', 'run_code was cancelled')
      if (spec.signal?.aborted) queueMicrotask(onAbort)
      else spec.signal?.addEventListener('abort', onAbort, { once: true })
      const finish = (result) => {
        if (!this.pending) return
        this.pending = undefined
        clearTimeout(timer)
        spec.signal?.removeEventListener('abort', onAbort)
        subcalls.abort('run_code settled')
        if (stopping && result.error) result.error = { kind: stopping.kind, message: `${stopping.message}. ${result.error.message}` }
        resolveRun(result)
      }
      this.pending = { spec, finish, signal: subcalls.signal, subcalls: 0 }
      this.send({
        t: 'run',
        program: spec.program,
        cwd: spec.cwd,
        cap: outputMaxChars,
        bindings: spec.bindings.map((b) => ({ global: b.global, names: Object.keys(b.functions), errorClass: b.errorClass ?? null })),
      })
    })
  }

  /** Count sub-calls against this run_code call's budget; throws (the REPL sees the message) when it is used up. */
  countSubcalls(p, n) {
    const { maxSubcallsPerRun } = this.runtime.config
    if (p.subcalls + n > maxSubcallsPerRun) {
      throw new Error(`sub-call budget for this run_code call is used up (${maxSubcallsPerRun}); combine what you have, or continue in another run_code call`)
    }
    p.subcalls += n
  }

  async onFrame(line) {
    let f
    try { f = JSON.parse(line) } catch { return } // not a frame: ignore
    const p = this.pending
    if (!p || typeof f !== 'object' || f === null) return
    if (f.t === 'done') {
      const raw = typeof f.output === 'string' ? f.output : ''
      const cut = Number.isInteger(f.total) ? f.total - raw.length : 0
      const output = raw.replace(/\n$/, '')
      const logs = []
      if (output) logs.push(cut > 0 ? `${output}\n[... ${cut} more characters truncated. Keep large text in variables and read it with llm/llm_batch.]` : output)
      const result = { logs }
      if (typeof f.error === 'string' && f.error) result.error = { kind: 'exception', message: f.error }
      else if (f.value !== undefined && f.value !== null) result.value = f.value
      p.finish(result)
    } else if (f.t === 'call' && Number.isInteger(f.cid)) {
      const ns = p.spec.bindings.find((b) => b.global === f.global)
      const fn = ns && Object.hasOwn(ns.functions, f.name) ? ns.functions[f.name] : undefined
      try {
        if (!fn) throw new Error(`no such function ${f.global}.${f.name}`)
        if (f.name === LLM_TOOL) this.countSubcalls(p, 1)
        this.send({ t: 'reply', cid: f.cid, value: (await fn(f.args)) ?? null })
      } catch (e) {
        this.send({ t: 'reply', cid: f.cid, error: String(e?.message ?? e) })
      }
    } else if (f.t === 'blob') {
      putBlob(f.id, f.text) // a wrong id stores nothing; the sub-call that names it then fails and says so
    } else if (f.t === 'llm' && Number.isInteger(f.cid) && Array.isArray(f.items)) {
      // Direct sub-calls, when the session has no `llm` tool: the same items the tool takes.
      try {
        this.countSubcalls(p, f.items.length)
        const base = this.runtime.subcallRoute(p.spec.stateOwner)
        if (!base) throw new Error('no model is selected for sub-calls')
        const one = async (item) => {
          let prompt = String(item?.prompt ?? '')
          if (item?.prefix_id !== undefined) {
            const prefix = getBlob(item.prefix_id)
            if (prefix === undefined) throw new Error(`${MISSING_PREFIX}: send the prefix again`)
            prompt = prefix + SEPARATOR + prompt
          }
          const route = await withThinking(this.runtime.ctx.llm, base, item?.thinking)
          await this.gate.take()
          try {
            if (p.signal.aborted) throw new Error('run_code was stopped')
            return await this.runtime.complete(prompt, route, p.signal)
          } finally {
            this.gate.give()
          }
        }
        this.send({ t: 'reply', cid: f.cid, value: await Promise.all(f.items.map(one)) })
      } catch (e) {
        this.send({ t: 'reply', cid: f.cid, error: String(e?.message ?? e) })
      }
    }
  }
}
