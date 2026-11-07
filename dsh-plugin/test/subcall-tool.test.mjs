// KV cache: none
// Offline tests for lib/subcall-tool.js and lib/subcalls.js: the `llm` dsh tool against a fake model service.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { llmTool, LLM_TOOL } from '../lib/subcall-tool.js'
import { subcallRoute, completeSubcall } from '../lib/subcalls.js'

/** A fake ctx.llm: records each request and streams `reply(prompt)` with fixed usage. */
function fakeLlm(reply = (p) => `<${p}>`, usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 7 }) {
  const requests = []
  return {
    requests,
    async *stream(options) {
      requests.push(options)
      const prompt = options.messages[0].content[0].text
      if (prompt === 'FAIL') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'rate limited' } } }
        return
      }
      yield { type: 'text-delta', index: 0, text: reply(prompt) }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const agent = (id = 'session-1') => ({ id, model: { current: () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' }) } })

test('the tool is named llm, takes one prompt and is parallel-safe', () => {
  const tool = llmTool(fakeLlm())
  assert.equal(LLM_TOOL, 'llm')
  assert.equal(tool.name, 'llm')
  assert.equal(tool.isConcurrencySafe({ prompt: 'x' }), true)
})

test('execute returns the text and usage on the agent route with its own affinity key', async () => {
  const llm = fakeLlm()
  const tool = llmTool(llm)
  const value = await tool.execute({ prompt: 'hi' }, { agent: agent(), signal: new AbortController().signal })
  assert.deepEqual(value, { text: '<hi>', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 7 } })
  const req = llm.requests[0]
  assert.equal(req.provider, 'p')
  assert.equal(req.model, 'm')
  assert.equal(req.reasoningEffort, 'high')
  assert.equal(req.sessionId, 'session-1:sub')
  assert.equal(req.maxTokens, 16384)
})

test('a provider failure becomes a tool error', async () => {
  const tool = llmTool(fakeLlm())
  await assert.rejects(tool.execute({ prompt: 'FAIL' }, { agent: agent(), signal: new AbortController().signal }), /rate limited/)
})

test('the run signal reaches the model call', async () => {
  const llm = fakeLlm()
  const ac = new AbortController()
  await llmTool(llm).execute({ prompt: 'x' }, { agent: agent(), signal: ac.signal })
  assert.equal(llm.requests[0].signal, ac.signal)
})

test('a configured sub-call model wins, with its own effort and no inherited one', () => {
  assert.deepEqual(subcallRoute({ subProvider: 'q', subModel: 'small' }, agent()), { provider: 'q', model: 'small', sessionId: 'session-1:sub' })
  assert.deepEqual(subcallRoute({ subProvider: 'q', subModel: 'small', subReasoningEffort: 'low' }, agent()),
    { provider: 'q', model: 'small', reasoningEffort: 'low', sessionId: 'session-1:sub' })
  assert.equal(subcallRoute({}, undefined), undefined)
})

test('completeSubcall adds up usage chunks', async () => {
  const llm = {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: 'a' }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'text-delta', index: 0, text: 'b' }
      yield { type: 'usage', usage: { inputTokens: 2, cacheReadTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  assert.deepEqual(await completeSubcall(llm, 'p', { provider: 'x', model: 'y' }), { text: 'ab', usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 3 } })
})

test('the rendered result carries the usage line for the Trajectory view', () => {
  const tool = llmTool(fakeLlm())
  const value = { text: 'answer', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 7 } }
  assert.deepEqual(tool.output.render({ prompt: 'q' }, value), [{ type: 'text', text: 'answer\n\n[sub-call tokens: 10 in, 7 of them cached; 2 out]' }])
})

test('a stored prefix is sent first; an unknown or forged one fails', async () => {
  const { putBlob, blobId } = await import('../lib/blobs.js')
  const llm = fakeLlm()
  const tool = llmTool(llm)
  const seg = 'SEGMENT TEXT'
  assert.equal(putBlob('0'.repeat(64), seg), false, 'a forged id was stored')
  assert.equal(putBlob(blobId(seg), seg), true)
  const exec = { agent: agent(), signal: new AbortController().signal }
  await tool.execute({ prompt: 'q', prefix_id: blobId(seg) }, exec)
  assert.equal(llm.requests[0].messages[0].content[0].text, 'SEGMENT TEXT\n\nq')
  await assert.rejects(tool.execute({ prompt: 'q', prefix_id: blobId('other') }, exec), /unknown prefix_id/)
})

test('thinking maps onto the model\'s own efforts, least first', async () => {
  const { withThinking } = await import('../lib/subcalls.js')
  const llm = { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] } }) }
  const route = { provider: 'p2', model: 'm2', reasoningEffort: 'high' }
  assert.equal((await withThinking(llm, route, 'medium')).reasoningEffort, 'medium')
  assert.equal((await withThinking(llm, route, 'off')).reasoningEffort, 'low')
  assert.equal((await withThinking(llm, route, 'max')).reasoningEffort, 'high')
  assert.equal(await withThinking(llm, route, undefined), route)
  const none = { resolveModelInfo: async () => ({}) }
  assert.deepEqual(await withThinking(none, { provider: 'p3', model: 'm3' }, 'low'), { provider: 'p3', model: 'm3' })
})
