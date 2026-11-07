// KV cache: none
// Offline tests for step 7: the REPL launched through dsh's sandbox service under the session's file policy.
// A fake sandbox service passes the argv through unchanged (so the real REPL runs) and records each confine call.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import RlmPythonRuntime, { samePolicy } from '../lib/rlm-runtime.js'

const made = []
after(() => Promise.all(made.flatMap((rt) => [...rt.all].map((r) => r.kill()))))

const policy = (mode, extra = {}) => ({ mode, workspaceRoot: process.cwd(), sessionId: 's1', ...extra })

/** A runtime whose context has a fake sandbox (and policy) service; `refuse` makes confine throw. */
function make({ sandbox = true, refuse = false, defaultMode = 'workspace-write' } = {}) {
  const ctx = new Context()
  const rt = new RlmPythonRuntime(ctx, {})
  made.push(rt)
  const confines = []
  const services = {
    sandboxPolicy: { defaultMode, resolve: () => policy(defaultMode) },
    ...(sandbox ? {
      sandbox: {
        async confine(argv, p) {
          confines.push({ argv, policy: p })
          if (refuse) throw new Error('no runner can enforce read-only here')
          return { argv: [...argv], enforcement: 'partial', denialSignatures: ['Permission denied', 'Access is denied'], runnerFailureRules: [] }
        },
      },
    } : {}),
  }
  const get = ctx.get.bind(ctx)
  ctx.get = (name) => services[name] ?? get(name)
  rt.confines = confines
  return rt
}

const owner = { id: 'session-sbx', model: { current: () => ({ provider: 'p', model: 'm' }) } }
const run = (rt, program, extra = {}) => rt.run(rt.resolve({ program, bindings: [], ...extra }))

test('the runtime reports the deployment mode, and resolve takes the session policy and its root', () => {
  const rt = make({ defaultMode: 'read-only' })
  assert.equal(rt.sandboxMode, 'read-only')
  const spec = rt.resolve({ program: 'x', bindings: [] })
  assert.equal(spec.sandboxPolicy.mode, 'read-only')
  assert.equal(spec.cwd, process.cwd())
})

test('a confined mode launches the REPL through the sandbox, with -B, and reports the facts', async () => {
  const rt = make()
  const res = await run(rt, '1 + 1', { sandboxPolicy: policy('read-only'), stateOwner: owner })
  assert.equal(res.value, 2)
  assert.equal(rt.confines.length, 1)
  assert.equal(rt.confines[0].policy.mode, 'read-only')
  assert.ok(rt.confines[0].argv.includes('-B'))
  assert.deepEqual(res.sandbox, { mode: 'read-only', denied: false, enforcement: 'partial' })
  await rt.release(owner)
})

test('danger-full-access launches the REPL directly', async () => {
  const rt = make()
  const res = await run(rt, '3', { sandboxPolicy: policy('danger-full-access') })
  assert.equal(res.value, 3)
  assert.equal(rt.confines.length, 0)
  assert.deepEqual(res.sandbox, { mode: 'danger-full-access', denied: false })
})

test('a permission error in the cell is reported as a sandbox denial', async () => {
  const rt = make()
  const res = await run(rt, 'raise PermissionError(13, "Permission denied")', { sandboxPolicy: policy('read-only') })
  assert.equal(res.error.kind, 'exception')
  assert.equal(res.sandbox.denied, true)
})

test('a policy change restarts the REPL under the new policy and says so', async () => {
  const rt = make()
  await run(rt, 'keep = 1', { sandboxPolicy: policy('workspace-write'), stateOwner: owner })
  const res = await run(rt, 'print("hi")', { sandboxPolicy: policy('read-only'), stateOwner: owner })
  assert.match(res.logs[0], /file policy changed to read-only/)
  assert.equal(res.logs[1], 'hi')
  assert.equal(rt.confines.at(-1).policy.mode, 'read-only')
  await rt.release(owner)
})

test('without a sandbox service a confined mode fails closed', async () => {
  const rt = make({ sandbox: false })
  const res = await run(rt, '1', { sandboxPolicy: policy('read-only') })
  assert.equal(res.error.kind, 'sandbox-unavailable')
})

test('a sandbox that refuses the policy fails closed', async () => {
  const rt = make({ refuse: true })
  const res = await run(rt, '1', { sandboxPolicy: policy('read-only') })
  assert.equal(res.error.kind, 'sandbox-unavailable')
  assert.match(res.error.message, /no runner can enforce/)
})

test('samePolicy compares mode, root, session and extra roots', () => {
  assert.equal(samePolicy(policy('read-only'), policy('read-only')), true)
  assert.equal(samePolicy(policy('read-only'), policy('workspace-write')), false)
  assert.equal(samePolicy(policy('workspace-write', { additionalWritableRoots: ['/a'] }), policy('workspace-write')), false)
  assert.equal(samePolicy(undefined, undefined), true)
  assert.equal(samePolicy(policy('read-only'), undefined), false)
})
