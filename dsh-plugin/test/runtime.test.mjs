// KV cache: none
// Offline tests for lib/rlm-runtime.js: the real REPL process, a fake model service (complete() replaced), fake
// tool bindings. Run from dsh-plugin/: node --test test/
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import RlmPythonRuntime, { replEnv, findPython, INSTRUCTIONS } from '../lib/rlm-runtime.js'

function owner(route = { provider: 'fake', model: 'main', reasoningEffort: 'high' }, id = 'session-test') {
  return { id, model: { current: () => route } }
}

const made = []
after(() => Promise.all(made.flatMap((rt) => [...rt.all].map((r) => r.kill()))))

function make(config = {}, complete) {
  const rt = new RlmPythonRuntime(new Context(), config)
  made.push(rt)
  rt.calls = []
  rt.complete = complete ?? (async (prompt, route) => { rt.calls.push({ prompt, route }); return `<${prompt}>` })
  return rt
}

function run(rt, program, extra = {}) {
  return rt.run(rt.resolve({ program, bindings: extra.bindings ?? [], ...extra }))
}

const tools = (fns) => [{ global: 'tools', functions: fns, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }]

test('a Python 3.10+ is found on this machine', () => {
  const py = findPython()
  assert.ok(py, 'no Python found')
})

test('state persists for one owner and not across owners', async () => {
  const rt = make()
  const a = owner(), b = owner()
  assert.equal((await run(rt, 'x = 5', { stateOwner: a })).error, undefined)
  assert.equal((await run(rt, 'x * 2', { stateOwner: a })).value, 10)
  assert.match((await run(rt, 'x', { stateOwner: b })).error.message, /NameError/)
  await rt.release(a); await rt.release(b)
})

test('tool bindings are awaited and their results read as attributes', async () => {
  const rt = make()
  const res = await run(rt, 'r = await tools.read({"file_path": "f"})\nprint(r.path, r["n"])', {
    bindings: tools({ read: async (args) => ({ path: args.file_path, n: 3 }) }),
  })
  assert.deepEqual(res.logs, ['f 3'])
})

test('sub-calls use the agent route with its reasoning effort by default', async () => {
  const rt = make()
  const o = owner()
  const res = await run(rt, 'print(llm("a"), llm_batch(["b", "c"]))', { stateOwner: o })
  assert.deepEqual(res.logs, ["<a> ['<b>', '<c>']"])
  // its own affinity key: sticky for the agent's sub-calls, never the root's own key (rlmh D-118)
  assert.deepEqual(rt.calls[0].route, { provider: 'fake', model: 'main', reasoningEffort: 'high', sessionId: 'session-test:sub' })
  await rt.release(o)
})

test('a configured sub-call model overrides the route and does not inherit the main effort', () => {
  const rt = make({ subProvider: 'fake', subModel: 'small' })
  assert.deepEqual(rt.subcallRoute(owner()), { provider: 'fake', model: 'small', sessionId: 'session-test:sub' })
  const rt2 = make({ subProvider: 'fake', subModel: 'small', subReasoningEffort: 'low' })
  assert.deepEqual(rt2.subcallRoute(owner(undefined, null)), { provider: 'fake', model: 'small', reasoningEffort: 'low' })
})

test('llm_batch respects the parallel limit', async () => {
  let live = 0, peak = 0
  const rt = make({ maxParallelSubcalls: 2 }, async (p) => {
    live++; peak = Math.max(peak, live)
    await new Promise((r) => setTimeout(r, 30))
    live--
    return p
  })
  const res = await run(rt, 'len(llm_batch([str(i) for i in range(6)]))', { stateOwner: owner() })
  assert.equal(res.value, 6)
  assert.equal(peak, 2)
})

test('the sub-call budget per run_code call is enforced', async () => {
  const rt = make({ maxSubcallsPerRun: 3 })
  const res = await run(rt, 'llm_batch(["a", "b", "c", "d"])', { stateOwner: owner() })
  assert.match(res.error.message, /budget/)
})

test('a timeout interrupts the cell, stops its sub-calls and keeps variables', async () => {
  let aborted
  const rt = make({ graceMs: 3000 }, (p, route, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
  }))
  const o = owner()
  await run(rt, 'keep = 1', { stateOwner: o })
  const res = await run(rt, 'llm("never")', { stateOwner: o, timeoutMs: 500 })
  assert.equal(res.error.kind, 'timeout')
  assert.ok(aborted, 'the pending sub-call was not aborted')
  assert.equal((await run(rt, 'keep', { stateOwner: o })).value, 1)
  await rt.release(o)
})

test('a busy loop that ignores the interrupt is killed after the grace period, and the next call says so', async () => {
  const rt = make({ graceMs: 500 })
  const o = owner()
  await run(rt, 'keep = 1', { stateOwner: o })
  const res = await run(rt, 'import time\nwhile True:\n    try:\n        time.sleep(0.05)\n    except KeyboardInterrupt:\n        pass', { stateOwner: o, timeoutMs: 500 })
  assert.equal(res.error.kind, 'timeout')
  const next = await run(rt, 'print("hi")', { stateOwner: o })
  assert.match(next.logs[0], /REPL restarted/)
  assert.equal(next.logs[1], 'hi')
  await rt.release(o)
})

test('cancelling stops the run', async () => {
  const rt = make({}, (p, r, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stop')))))
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 300)
  const res = await run(rt, 'llm("x")', { stateOwner: owner(), signal: ac.signal })
  assert.equal(res.error.kind, 'abort')
})

test('long output is cut with a note', async () => {
  const rt = make({ outputMaxChars: 20 })
  const res = await run(rt, 'print("y" * 100)')
  assert.match(res.logs[0], /^y{20}\n\[\.\.\. 81 more characters truncated/)
})

test('a run without an owner uses a throwaway REPL', async () => {
  const rt = make()
  await run(rt, 'z = 1')
  assert.match((await run(rt, 'z')).error.message, /NameError/)
  assert.equal(rt.all.size, 0)
})

test('the REPL gets no key-like variables, and git config sets go whole', () => {
  const env = replEnv({ PATH: 'p', OPENROUTER_API_KEY: 'sk-FAKE', GH_TOKEN: 'x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'b', HOME: 'h' })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'PYTHONIOENCODING', 'PYTHONUTF8'])
})

test('the instructions are fixed text', () => {
  assert.equal(make().executionInstructions, INSTRUCTIONS)
  assert.doesNotMatch(INSTRUCTIONS, /\d{4}-\d{2}-\d{2}/)
})

test('with an llm tool in the bindings, llm()/llm_batch() go through it, one call each, and count toward the budget', async () => {
  const rt = make({ maxSubcallsPerRun: 3 })
  const seen = []
  const llm = async ({ prompt }) => { seen.push(prompt); return { text: prompt.toUpperCase(), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } } }
  const o = owner()
  const res = await run(rt, 'print(llm("a"), llm_batch(["b", "c"]))', { stateOwner: o, bindings: tools({ llm }) })
  assert.deepEqual(res.logs, ["A ['B', 'C']"])
  assert.deepEqual(seen.sort(), ['a', 'b', 'c'])
  assert.equal(rt.calls.length, 0, 'the direct path was used')
  const over = await run(rt, 'llm_batch(["d", "e", "f", "g"])', { stateOwner: o, bindings: tools({ llm }) })
  assert.match(over.error.message, /budget/)
  await rt.release(o)
})

test('a failing llm tool call raises in the cell', async () => {
  const rt = make()
  const llm = async () => { throw new Error('rate limited') }
  const res = await run(rt, 'llm_batch(["a", "b"])', { stateOwner: owner(), bindings: tools({ llm }) })
  assert.match(res.error.message, /2 of 2 sub-calls failed; first: rate limited/)
})
