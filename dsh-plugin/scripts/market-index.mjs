// KV cache: none (a release tool; nothing here reaches a model request).
//
// Writes market/index.json, a dsh plugin market index (format 1) that lists rlmh-dsh's published versions, so a dsh
// user can add its raw URL under Plugins -> Discover -> Index sources. Each version's publish time comes from npm
// (`npm view rlmh-dsh time`), so run this after a version is on npm. Versions already in the file are kept.
// The result is checked with dsh's own validator (@deepseek-ai/dsh-plugin-market-index) before it is written.
// Usage (in dsh-plugin/): node scripts/market-index.mjs [--timestamp <unix seconds>]   (--timestamp: offline, tests)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

export const INDEX_URL = 'https://raw.githubusercontent.com/RishiJain905/rlm-harness/dsh-plugin/dsh-plugin/market/index.json'

/** The plugin's entry for one version, from package.json. */
export function versionEntry(pkg, publishTimestamp) {
  return { version: pkg.version, publishTimestamp, source: { type: 'npm' }, engines: { dsh: pkg.engines.dsh } }
}

/** The whole index: the package's current metadata, previous versions kept, this version replaced or added. */
export function buildIndex(pkg, publishTimestamp, previous) {
  const kept = (previous?.plugins?.find((p) => p.name === pkg.name)?.versions ?? []).filter((v) => v.version !== pkg.version)
  const index = {
    format: 1,
    title: 'rlm-harness',
    description: 'Plugins from rlm-harness (github.com/RishiJain905/rlm-harness).',
    plugins: [{
      name: pkg.name,
      title: 'RLM mode',
      description: pkg.description,
      author: pkg.author,
      homepage: pkg.homepage,
      repository: { url: 'https://github.com/RishiJain905/rlm-harness', directory: 'dsh-plugin' },
      metadata: { keywords: pkg.keywords ?? [] },
      versions: [versionEntry(pkg, publishTimestamp), ...kept],
    }],
  }
  parseMarketIndex(structuredClone(index), INDEX_URL) // throws MarketIndexError on any violation
  return index
}

/** The version's publish time on npm, in Unix seconds. */
function npmPublishTime(name, version) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const out = execFileSync(npm, ['view', name, 'time', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' })
  const iso = JSON.parse(out)[version]
  if (!iso) throw new Error(`${name}@${version} is not on npm yet; publish it first`)
  return Math.floor(Date.parse(iso) / 1000)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const at = process.argv.indexOf('--timestamp')
  const ts = at > 0 ? Number(process.argv[at + 1]) : npmPublishTime(pkg.name, pkg.version)
  const file = join(root, 'market', 'index.json')
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  const index = buildIndex(pkg, ts, previous)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(index, null, 2) + '\n')
  console.log(`wrote ${file}: ${pkg.name} ${index.plugins[0].versions.map((v) => v.version).join(', ')}`)
}
