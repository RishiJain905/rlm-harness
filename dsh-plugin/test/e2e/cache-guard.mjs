// KV cache: this is the guard. It checks, on the real dsh, that RLM mode keeps every main-conversation request a
// byte-for-byte extension of the one before (same system prompt, same tool list, same earlier messages), and that
// sub-calls go out as separate requests with their own affinity key.
//
// Run (needs a dsh CLI; no network, no real key):
//   node test/e2e/cache-guard.mjs            from dsh-plugin/
// dsh is found as $DSH_CLI, else DeepSeek Harness desktop's CLI on Windows, else `dsh` on PATH.
// It starts a fake OpenAI-compatible model server on 127.0.0.1, makes a throwaway DSH_HOME with a headless profile
// that has this plugin installed and RLM mode's runtime and sub-call tool switched on, runs one scripted task, and
// checks every request the server recorded. Exit 0 when every check passes.
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FAKE_KEY = 'sk-FAKE-cache-guard'

function findDsh() {
  if (process.env.DSH_CLI) return process.env.DSH_CLI
  const desktop = 'F:/Personal/AI/Deepseek/resources/runtime/cli/bin/dsh.cmd'
  if (process.platform === 'win32' && existsSync(desktop)) return desktop
  return 'dsh'
}

/**
 * Run the dsh CLI without blocking: the fake model server lives in this process, so a synchronous spawn would stall
 * it. Windows .cmd launchers need a shell, so arguments are quoted for cmd.exe there.
 */
function dsh(cli, args, opts) {
  const viaShell = process.platform === 'win32'
  const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)
  const child = viaShell
    ? spawn(`"${cli}" ${args.map(quote).join(' ')}`, { ...opts, shell: true })
    : spawn(cli, args, opts)
  let stdout = '', stderr = ''
  child.stdout.on('data', (b) => { stdout += b })
  child.stderr.on('data', (b) => { stderr += b })
  return new Promise((res) => {
    const timer = opts.timeout ? setTimeout(() => child.kill(), opts.timeout) : undefined
    child.on('close', (code) => { clearTimeout(timer); res({ code, stdout, stderr }) })
  })
}

// ---------------------------------------------------------------- the fake model server

const requests = [] // { kind, body, headers }
const ROOT_SCRIPT = [
  { code: 'x = 41\nprint(llm("say hello"))', description: 'Set x and make one sub-call' },
  { code: 'print(x + 1)', description: 'Reuse x' },
  null, // a plain reply ends the turn
]

function kindOf(body) {
  if (Array.isArray(body.tools) && body.tools.length > 0) return 'root'
  const text = JSON.stringify(body.messages ?? [])
  if (text.includes('Create a concise title')) return 'title'
  return 'sub'
}

function chunks(body, delta, finish, usage) {
  const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: body.model }
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { ...base, choices: [], usage },
  ]
}

function reply(body, kind) {
  const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }
  if (kind === 'title') return chunks(body, { content: 'Cache guard' }, 'stop', usage)
  if (kind === 'sub') return chunks(body, { content: 'hello' }, 'stop', usage)
  const step = requests.filter((r) => r.kind === 'root').length - 1
  const call = ROOT_SCRIPT[Math.min(step, ROOT_SCRIPT.length - 1)]
  if (!call) return chunks(body, { content: 'done' }, 'stop', usage)
  return chunks(body, {
    tool_calls: [{ index: 0, id: `call_${step}`, type: 'function', function: { name: 'run_code', arguments: JSON.stringify(call) } }],
  }, 'tool_calls', usage)
}

const server = http.createServer((req, res) => {
  let data = ''
  req.on('data', (c) => { data += c })
  req.on('end', () => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
    }
    let body = {}
    try { body = JSON.parse(data) } catch {}
    const kind = kindOf(body)
    requests.push({ kind, body, headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const c of reply(body, kind)) res.write(`data: ${JSON.stringify(c)}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})

// ---------------------------------------------------------------- checks

const failures = []
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'rlmh-cache-guard-'))
  const work = join(home, 'work')
  const cli = findDsh()
  const env = { ...process.env, DSH_HOME: home, RLMH_FAKE_PROVIDER_KEY: FAKE_KEY, NO_COLOR: '1' }
  try {
    spawnSync(process.platform === 'win32' ? 'cmd' : 'mkdir', process.platform === 'win32' ? ['/c', 'mkdir', work] : ['-p', work])
    let r = await dsh(cli, ['cacheguard', '--from-default-profile', 'headless', '--help'], { env, cwd: home })
    check(existsSync(join(home, 'profiles', 'cacheguard')), 'a throwaway headless profile was created')
    r = await dsh(cli, ['plugin', '--profile', 'cacheguard', 'add', PLUGIN.replace(/\\/g, '/')], { env, cwd: home })
    check(r.code === 0, `the plugin installs into it (${r.code})`)
    writeFileSync(join(home, 'profiles', 'cacheguard', 'cordis.patch.yml'), `
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      # named openrouter so pi-ai sends OpenRouter's session-affinity header (x-session-id), pointed at the fake
      openrouter:
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1
        apiKeyEnv: RLMH_FAKE_PROVIDER_KEY
        models:
          - id: fake-model
            contextWindow: 200000
            reasoningEfforts: false
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: openrouter
    model: fake-model
- id: ptc-runtime
  disabled: true
- id: workflow-ptc
  disabled: true
- id: tool-workflow
  disabled: true
- id: tool-executor-native
  disabled: true
- id: tool-executor-ptc
  disabled: false
- id: rlm-runtime
  disabled: false
- id: rlm-subcall-tool
  disabled: false
`)
    r = await dsh(cli, ['--profile', 'cacheguard', '--json', '--permission-mode', 'read-only', 'Run the scripted steps.'], { env, cwd: work, timeout: 300_000 })
    check(r.code === 0, `the headless run finished (${r.code})`)
    if (r.code !== 0) console.log(r.stderr.split('\n').filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).slice(0, 15).join('\n'))

    const roots = requests.filter((q) => q.kind === 'root')
    const subs = requests.filter((q) => q.kind === 'sub')
    check(roots.length === 3, `three main-conversation requests (${roots.length})`)
    check(subs.length === 1, `one sub-call request (${subs.length})`)
    for (let i = 1; i < roots.length; i++) {
      const prev = roots[i - 1].body
      const cur = roots[i].body
      check(same(prev.tools, cur.tools), `request ${i + 1} declares the same tools, byte for byte`)
      const n = prev.messages.length
      const prefixOk = cur.messages.length > n && cur.messages.slice(0, n).every((m, k) => same(m, prev.messages[k]))
      if (!prefixOk) {
        const k = prev.messages.findIndex((m, j) => !same(m, cur.messages[j]))
        console.log(`  first differing message: ${k} (${JSON.stringify(prev.messages[k])?.slice(0, 160)} -> ${JSON.stringify(cur.messages[k])?.slice(0, 160)})`)
      }
      check(prefixOk, `request ${i + 1} starts with request ${i}'s messages, byte for byte`)
    }
    const rootKey = roots[0]?.headers['x-session-id']
    check(typeof rootKey === 'string' && roots.every((q) => q.headers['x-session-id'] === rootKey), 'the main conversation keeps one affinity key')
    check(subs.length > 0 && subs.every((q) => q.headers['x-session-id'] === `${rootKey}:sub`), 'sub-calls carry their own key, <session>:sub')
    check(subs.length > 0 && !('tools' in subs[0].body && subs[0].body.tools?.length), 'a sub-call is a separate request with no tools')
    const lastRoot = roots.at(-1)?.body.messages ?? []
    const results = JSON.stringify(lastRoot.filter((m) => m.role === 'tool'))
    check(results.includes('hello') && results.includes('42'), 'the REPL kept x between run_code calls and the sub-call answered')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  }
  console.log(failures.length ? `CACHE GUARD: FAIL (${failures.length})` : 'CACHE GUARD: PASS')
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
