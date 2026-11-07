// KV cache: none
// Offline tests for lib/rlm-tool.js: the `rlm` dsh tool against a fake subagents service.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rlmTool, RLM_TOOL, childPrompt } from '../lib/rlm-tool.js'

/** A fake ctx.subagents: records each start; the child answers `reply` with `stopReason`. */
function fakeSubagents({ reply = 'child answer', stopReason = 'completed', diagnostic, hang = false, noDepthLimit = false } = {}) {
  const starts = []
  const svc = {
    starts,
    disposed: 0,
    resolveMaxDepth: () => (noDepthLimit ? undefined : 1),
    async startActivation(spec) {
      starts.push(spec)
      let release
      const result = hang
        ? new Promise((res) => { release = () => res({ output: [], stopReason: 'cancelled' }) })
        : Promise.resolve({ output: [{ type: 'text', text: reply }], stopReason, ...(diagnostic ? { diagnostic } : {}) })
      return { childId: 'session-child-1', result, dispose: async () => { svc.disposed++; release?.() } }
    },
  }
  return svc
}

const exec = (signal = new AbortController().signal) => ({ agent: { id: 'session-parent' }, signal })

test('the tool is named rlm and may run beside others', () => {
  const tool = rlmTool(fakeSubagents())
  assert.equal(RLM_TOOL, 'rlm')
  assert.equal(tool.name, 'rlm')
  assert.equal(tool.isConcurrencySafe({ task: 't' }), true)
})

test('a child run starts on the in-process backend in RLM mode, delivered to the caller, and returns its answer', async () => {
  const svc = fakeSubagents()
  const value = await rlmTool(svc).execute({ task: 'Summarize the parser.' }, exec())
  assert.deepEqual(value, { text: 'child answer', childId: 'session-child-1' })
  const spec = svc.starts[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.request.agentPreset, 'rlm')
  assert.equal(spec.request.maxDepth, 1)
  assert.equal(spec.request.parent.id, 'session-parent')
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: 'Summarize the parser.' }])
})

test('context goes to a file the child loads, not into its prompt', async () => {
  const svc = fakeSubagents()
  const context = 'line one\nline two\n'.repeat(1000)
  await rlmTool(svc).execute({ task: 'Count the lines.', context }, exec())
  const text = svc.starts[0].request.prompt[0].text
  assert.ok(!text.includes('line one'), 'the context was put into the prompt')
  const path = /in the file (\S+) \(/.exec(text)[1]
  assert.equal(readFileSync(path, 'utf8'), context)
  assert.match(text, /18,000 characters/)
})

test('a child that stops early is an error with its diagnostic', async () => {
  const svc = fakeSubagents({ stopReason: 'error', diagnostic: 'model unavailable' })
  await assert.rejects(rlmTool(svc).execute({ task: 't' }, exec()), /ended without an answer \(error\): model unavailable/)
})

test('cancelling the run disposes the child', async () => {
  const svc = fakeSubagents({ hang: true })
  const ac = new AbortController()
  const pending = rlmTool(svc).execute({ task: 't' }, exec(ac.signal))
  await new Promise((r) => setTimeout(r, 20))
  ac.abort()
  await assert.rejects(pending, /ended without an answer \(cancelled\)/)
  assert.equal(svc.disposed, 1)
})

test('no depth limit from the user means no maxDepth in the request', async () => {
  const svc = fakeSubagents({ noDepthLimit: true })
  await rlmTool(svc).execute({ task: 't' }, exec())
  assert.equal('maxDepth' in svc.starts[0].request, false)
})

test('childPrompt names the file and its size', () => {
  assert.equal(childPrompt('T', undefined, 0), 'T')
  assert.match(childPrompt('T', 'C:/x/y.txt', 1234), /^T\n\nYour input is the text in the file C:\/x\/y.txt \(1,234 characters\)/)
})
