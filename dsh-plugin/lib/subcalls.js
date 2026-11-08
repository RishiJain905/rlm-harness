// KV cache: a sub-call is its own request. Its route carries a session id that pi-ai sends to OpenRouter as the
// affinity key and prompt_cache_key; sub-calls get `<agent session>:sub`, stable for the agent and never the root's
// own key, so they stay on one warm backend without moving the root off its own (rlmh D-118).
//
// Sub-calls for RLM mode: which model they use, and one call through dsh's model service (ctx.llm).

export const SUBCALL_DEFAULTS = Object.freeze({
  subcallMaxTokens: 16384,
})

/** rlmh's thinking levels, least first (rlmh D-250), as the REPL's thinking= takes them. */
export const THINKING = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export const SEPARATOR = '\n\n' // between a prefix and its prompt (python/rlmapi.py SEPARATOR)

const effortCache = new Map() // `${provider}\0${model}` -> effort ids, least first ([] when the model has none)

/**
 * The route with `thinking` applied: the model's own effort of that name, else the one at the same relative position
 * in its list (least first). A model without reasoning efforts keeps the route as it is.
 */
export async function withThinking(llm, route, thinking) {
  if (!thinking) return route
  const ids = await effortIds(llm, route)
  if (ids.length === 0) return route
  const id = ids.includes(thinking) ? thinking : ids[Math.round((THINKING.indexOf(thinking) / (THINKING.length - 1)) * (ids.length - 1))]
  return { ...route, reasoningEffort: id }
}

/** The model's own reasoning-effort ids, least first ([] when it has none or the adapter can't say), cached. */
async function effortIds(llm, route) {
  const key = `${route.provider}\0${route.model}`
  let ids = effortCache.get(key)
  if (ids === undefined) {
    try {
      const info = await llm.resolveModelInfo?.(route.provider, route.model)
      ids = (info?.reasoning?.efforts ?? []).map((e) => e.id).filter((id) => typeof id === 'string')
    } catch {
      ids = []
    }
    effortCache.set(key, ids)
  }
  return ids
}

/**
 * The route with its reasoning effort made one the model offers, so a mistyped or unsupported setting can't fail
 * every sub-call: an effort the model has stays; one of rlmh's levels maps to the model's effort at the same
 * relative position; any other word is dropped (the model's default applies). Unknown effort lists keep the route.
 */
export async function fitEffort(llm, route) {
  const effort = route.reasoningEffort
  if (!effort) return route
  const ids = await effortIds(llm, route)
  if (ids.length === 0 || ids.includes(effort)) return route
  if (THINKING.includes(effort)) return withThinking(llm, route, effort)
  const { reasoningEffort: _dropped, ...rest } = route
  return rest
}

/**
 * The route a sub-call uses: the configured sub-call model, else the agent's own model and reasoning effort.
 * @param {object} config - subProvider, subModel, subReasoningEffort (all optional).
 * @param {object} [agent] - the dsh Agent (id, model.current()).
 */
export function subcallRoute(config, agent) {
  let current
  try { current = agent?.model?.current?.() } catch {}
  const provider = config.subProvider ?? current?.provider
  const model = config.subModel ?? current?.model
  if (!provider || !model) return undefined
  const sameModel = provider === current?.provider && model === current?.model
  const reasoningEffort = config.subReasoningEffort ?? (sameModel ? current?.reasoningEffort : undefined)
  const sessionId = typeof agent?.id === 'string' ? `${agent.id}:sub` : undefined
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}), ...(sessionId ? { sessionId } : {}) }
}

/**
 * One sub-call: stream it through `llm.stream` and return the text with the provider-reported usage.
 * @param {{stream(options: object): AsyncIterable<object>}} llm - dsh's model service (ctx.llm) or a fake.
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number, cacheReadTokens: number}}>}
 */
export async function completeSubcall(llm, prompt, route, signal, maxTokens = SUBCALL_DEFAULTS.subcallMaxTokens) {
  let text = ''
  let failure
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  for await (const c of llm.stream({
    ...route,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens,
    signal,
  })) {
    if (c.type === 'text-delta') text += c.text
    else if (c.type === 'usage') {
      usage.inputTokens += c.usage.inputTokens ?? 0
      usage.outputTokens += c.usage.outputTokens ?? 0
      usage.cacheReadTokens += c.usage.cacheReadTokens ?? 0
    } else if (c.type === 'finish' && (c.reason?.kind === 'error' || c.reason?.kind === 'aborted')) failure = c.reason.failure ?? c.reason
  }
  if (failure) throw new Error(failure.message ?? String(failure.code ?? 'sub-call failed'))
  if (process.env.RLMH_DSH_DEBUG) console.error(`[rlmh] sub-call ${route.provider}/${route.model} ${JSON.stringify(usage)}`)
  return { text, usage }
}
