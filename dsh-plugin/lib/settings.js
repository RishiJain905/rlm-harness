// KV cache: none (settings change what sub-calls and the REPL do, never the prompt or tool text)
// RLM mode's user settings, as one top-level dsh service (`rlmhSettings`). Every field is volatile: dsh's settings
// service (packages/settings) can edit it on the profile entry `rlmh-settings` without a reload, and the runtime and
// the `llm` tool read it on each use. An empty or unset field keeps the built-in behaviour.
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'rlmh-settings'

/** What each field means when it is unset. */
export const SETTING_DEFAULTS = Object.freeze({
  subProvider: '', // '' = the agent's own provider
  subModel: '', // '' = the agent's own model
  subReasoningEffort: '', // '' = the agent's own effort when the model is the agent's, else the model's default
  outputMaxChars: 8000,
  maxSubcallsPerRun: 200,
  maxParallelSubcalls: 8,
})

export default class RlmhSettings extends Service {
  static Config = z.object({
    subProvider: z.string().description('Sub-call provider route (for example openrouter). Empty: the same as the agent.').volatile(),
    subModel: z.string().description('Sub-call model id. Empty: the same model as the agent.').volatile(),
    subReasoningEffort: z.string().description('Sub-call reasoning effort (an effort the model offers, such as low or high). Empty: the agent\'s effort when the model is the agent\'s.').volatile(),
    outputMaxChars: z.number().min(1000).max(100000).description('How many characters of one run_code result the agent sees (default 8000).').volatile(),
    maxSubcallsPerRun: z.number().min(1).max(10000).description('Most sub-calls one run_code call may make (default 200).').volatile(),
    maxParallelSubcalls: z.number().min(1).max(64).description('Most sub-calls at once when dsh has no sub-call tool in the session (default 8).').volatile(),
  })

  constructor(ctx, config = {}) {
    super(ctx, 'rlmhSettings')
    this.config = config
  }

  /** The fields the user set now (volatile cells read live); unset and empty fields are left out. */
  explicit() {
    const out = {}
    for (const key of Object.keys(SETTING_DEFAULTS)) {
      const field = this.config?.[key]
      const value = typeof field?.get === 'function' ? field.get() : field
      if (value !== undefined && value !== null && value !== '') out[key] = value
    }
    return out
  }
}

/** A plugin row's config (defaults included) with the user's live settings on top. */
export function effective(ctx, base) {
  let set
  try { set = ctx?.get?.('rlmhSettings')?.explicit?.() } catch {}
  return set ? { ...base, ...set } : base
}
