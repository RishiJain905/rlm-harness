// KV cache: the tool's name, description and schema are fixed text registered once at load, so the PTC SDK stubs in
// the system prompt (and the cached prefix) never change. Each call is its own request (see subcalls.js).
//
// The `llm` dsh tool: one sub-call. RLM mode's REPL calls it for llm()/llm_batch(), one tool call per prompt, so
// dsh's PTC executor dispatches every sub-call: it is logged as a tool/ptc-dispatch (a Trajectory row, with its token
// usage as presentation metadata), cancelled with the run_code call, and run under dsh's sub-call parallelism cap.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SEPARATOR, SUBCALL_DEFAULTS, THINKING, completeSubcall, subcallRoute, withThinking } from './subcalls.js'
import { LLM_TOOL } from './tool-names.js'
import { MISSING_PREFIX, getBlob } from './blobs.js'
import { effective } from './settings.js'

export const name = 'rlmh-subcall-tool'
export const inject = ['tools', 'llm']

export { LLM_TOOL }

/** One sub-call's provider-reported usage, as shown in dsh's Trajectory view. */
export function usageLine(usage) {
  return `[sub-call tokens: ${usage.inputTokens} in, ${usage.cacheReadTokens} of them cached; ${usage.outputTokens} out]`
}

/** The tool definition, given where its model calls go (ctx.llm, or a fake in tests). */
export function llmTool(llm, config = {}, settings = () => ({})) {
  return defineTool({
    name: LLM_TOOL,
    description: 'One sub-call to a language model: send a prompt, get the reply text. In run_code, prefer the REPL\'s llm(prompt) and llm_batch(prompts), which call this.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The prompt (after the prefix, when there is one).' },
      prefix_id: { type: 'string', description: 'A shared prefix the REPL stored (a segment or shared text); sent first, so it is cached.' },
      thinking: { type: 'string', enum: [...THINKING], description: 'How much the sub-call may think; omit for the default.' },
    },
    output: {
      // dsh's value-schema DSL: requiredness per property, additionalProperties stated on every object
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          usage: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              inputTokens: { type: 'integer', required: true },
              outputTokens: { type: 'integer', required: true },
              cacheReadTokens: { type: 'integer', required: true },
            },
          },
        },
      },
      // In PTC mode a sub-tool's rendered content is log-only (the model sees only what the REPL prints), and it is
      // what the Trajectory view shows, so the usage line goes here: dsh's usage total doesn't count tool-internal calls.
      render: (_args, value) => [{ type: 'text', text: `${value.text}\n\n${usageLine(value.usage)}` }],
      presentationMeta: (_args, value) => ({ usage: value.usage }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cfg = { ...SUBCALL_DEFAULTS, ...config, ...settings() } // the user's live settings win
      const base = subcallRoute(cfg, exec.agent)
      if (!base) throw new Error('no model is selected for sub-calls')
      let prompt = args.prompt
      if (args.prefix_id !== undefined) {
        const prefix = getBlob(args.prefix_id)
        if (prefix === undefined) throw new Error(`${MISSING_PREFIX}: send the prefix again`)
        prompt = prefix + SEPARATOR + prompt // the shared bytes first, so the provider caches them
      }
      const route = await withThinking(llm, base, args.thinking)
      return completeSubcall(llm, prompt, route, exec.signal, cfg.subcallMaxTokens)
    },
  })
}

export function apply(ctx, config = {}) {
  ctx.tools.register(llmTool(ctx.llm, config, () => effective(ctx, {})))
}
