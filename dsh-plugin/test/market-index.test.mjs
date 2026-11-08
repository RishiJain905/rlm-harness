// KV cache: none (tests).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import { buildIndex, INDEX_URL } from '../scripts/market-index.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the index passes dsh\'s own validator and installs this version from npm', () => {
  const index = parseMarketIndex(buildIndex(pkg, 1794000000), INDEX_URL)
  const [plugin] = index.plugins
  assert.equal(plugin.name, 'rlmh-dsh')
  assert.deepEqual(plugin.versions[0], { version: pkg.version, publishTimestamp: 1794000000, source: { type: 'npm' }, engines: { dsh: pkg.engines.dsh } })
})

test('earlier versions are kept and the current one is replaced, newest first', () => {
  const older = buildIndex({ ...pkg, version: '1.0.9' }, 1700000000)
  const stale = buildIndex(pkg, 1, older)
  const index = parseMarketIndex(buildIndex(pkg, 1794000000, stale), INDEX_URL)
  assert.deepEqual(index.plugins[0].versions.map((v) => [v.version, v.publishTimestamp]), [[pkg.version, 1794000000], ['1.0.9', 1700000000]])
})

test('the package declares only the settings service and the RLM mode preset at top level (D-267)', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const topLevel = [...patch.matchAll(/^ {4}- id: (\S+)/gm)].map((m) => m[1])
  assert.deepEqual(topLevel, ['rlmh-settings', 'preset-rlm'])
})

test('the package is publishable: not private, with a README and LICENSE in its files', () => {
  assert.equal(pkg.private, undefined)
  for (const f of ['README.md', 'LICENSE', 'lib/', 'python/rlm_repl.py', 'python/rlmapi.py', 'cordis.patch.yml']) assert.ok(pkg.files.includes(f), f)
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(range, pkg.engines.dsh, `${name} follows engines.dsh, so a dsh update doesn't break the install`)
  }
})
