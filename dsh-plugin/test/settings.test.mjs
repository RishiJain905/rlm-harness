// KV cache: none
// Offline tests for lib/settings.js: the rlmhSettings service and how the runtime and tool read it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import RlmhSettings, { SETTING_DEFAULTS, effective } from '../lib/settings.js'

/** A volatile field as Cordis hands it over: a cell read with get(). */
const cell = (value) => ({ get: () => value })

test('the config schema accepts every setting and fills nothing in', () => {
  const parsed = RlmhSettings.Config({ subModel: 'm', outputMaxChars: 5000 })
  assert.ok(parsed)
  assert.throws(() => RlmhSettings.Config({ outputMaxChars: 10 }))
  assert.deepEqual(Object.keys(SETTING_DEFAULTS).sort(), ['maxParallelSubcalls', 'maxSubcallsPerRun', 'outputMaxChars', 'subModel', 'subProvider', 'subReasoningEffort'])
})

test('explicit() reports only fields the user set; empty strings count as unset', () => {
  const s = new RlmhSettings(new Context(), { subModel: cell('small'), subProvider: cell(''), outputMaxChars: cell(undefined), maxSubcallsPerRun: 50 })
  assert.deepEqual(s.explicit(), { subModel: 'small', maxSubcallsPerRun: 50 })
})

test('effective() puts set fields over the row config, and is the row config without the service', () => {
  const ctx = new Context()
  assert.deepEqual(effective(ctx, { outputMaxChars: 8000 }), { outputMaxChars: 8000 })
  const s = new RlmhSettings(ctx, { outputMaxChars: cell(4000) })
  const get = (name) => (name === 'rlmhSettings' ? s : undefined)
  assert.deepEqual(effective({ get }, { outputMaxChars: 8000, maxSubcallsPerRun: 200 }), { outputMaxChars: 4000, maxSubcallsPerRun: 200 })
})

test('a live change is seen on the next read, with no reload', () => {
  let model = 'a'
  const s = new RlmhSettings(new Context(), { subModel: { get: () => model } })
  const get = () => s
  assert.equal(effective({ get }, {}).subModel, 'a')
  model = 'b'
  assert.equal(effective({ get }, {}).subModel, 'b')
})
