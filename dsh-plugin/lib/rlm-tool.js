// KV cache: the tool's name, description and schema are fixed text registered once at load (PTC SDK stubs stay the
// same). A child run is its own dsh session with its own requests and cache.
//
// The `rlm` dsh tool: a child run, rlmh's rlm(task, context). The REPL's rlm() calls it. The child is a dsh subagent
// started through the subagents service with the RLM mode preset, so it has its own REPL and turns, shows in dsh's
// subagent views, and counts against the user's Subagent depth and capacity settings. The parent waits for its
// answer (delivery 'caller': no completion notice goes into the parent's conversation). A `context` text is not put
// into the child's prompt: it is written to a file the child loads into its REPL, as rlmh's input never enters a
// root prompt either.
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { blobId } from './blobs.js'
import { RLM_TOOL } from './tool-names.js'

export const name = 'rlmh-rlm-tool'
export const inject = ['tools', 'subagents']

export const RLM_DEFAULTS = Object.freeze({
  provider: 'spawn', // dsh's in-process subagent backend (the only one that takes agentPreset)
  agentPreset: 'rlm',
})

export { RLM_TOOL }

/** Where a child's input text goes: one file per distinct text, under the OS temp folder. */
export function contextFile(text, dir = join(tmpdir(), 'rlmh-dsh-context')) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${blobId(text).slice(0, 32)}.txt`)
  writeFileSync(path, text, 'utf8')
  return path.replace(/\\/g, '/')
}

/** The child's first message: the task, and where its input is when there is one. */
export function childPrompt(task, path, chars) {
  if (!path) return task
  return `${task}\n\nYour input is the text in the file ${path} (${chars.toLocaleString('en-US')} characters). Load it into a variable in the REPL and work on it there; do not print it whole.`
}

function outputText(output) {
  return (output ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
}

/** The tool definition, given the subagents service (ctx.subagents, or a fake in tests). */
export function rlmTool(subagents, config = {}) {
  const cfg = { ...RLM_DEFAULTS, ...config }
  return defineTool({
    name: RLM_TOOL,
    description: 'A child run: a new agent in RLM mode, with its own REPL and turns, does the task and its final answer comes back. In run_code, prefer the REPL\'s rlm(task, context=None), which calls this.',
    parameters: {
      task: { type: 'string', required: true, description: 'What the child should do and what its answer should contain.' },
      context: { type: 'string', description: 'Input text for the child; it gets it as a file to load into its REPL, not in its prompt.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          childId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.text}\n\n[child run ${value.childId}]` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('rlm() needs an agent to start a child from')
      const path = typeof args.context === 'string' && args.context ? contextFile(args.context) : undefined
      const maxDepth = subagents.resolveMaxDepth?.(cfg.maxDepth)
      const activation = await subagents.startActivation({
        provider: cfg.provider,
        label: args.task.slice(0, 80),
        request: {
          prompt: [{ type: 'text', text: childPrompt(args.task, path, args.context?.length ?? 0) }],
          parent: exec.agent,
          agentPreset: cfg.agentPreset,
          ...(maxDepth !== undefined ? { maxDepth } : {}),
        },
        signal: exec.signal,
        delivery: 'caller',
      })
      const stop = () => { activation.dispose().catch(() => {}) }
      exec.signal.addEventListener('abort', stop, { once: true })
      try {
        const result = await activation.result
        if (result.stopReason !== undefined && result.stopReason !== 'completed') {
          throw new Error(`the child run ended without an answer (${result.stopReason})${result.diagnostic ? `: ${result.diagnostic}` : ''}`)
        }
        return { text: outputText(result.output), childId: String(activation.childId) }
      } finally {
        exec.signal.removeEventListener('abort', stop)
      }
    },
  })
}

export function apply(ctx, config = {}) {
  ctx.tools.register(rlmTool(ctx.subagents, config))
}
