// KV cache: none
// Offline tests for lib/python-setup.js (step 5b). The real download is checked by hand; here a fake download.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UV_ARCHIVES, askText, canInstall, installPython } from '../lib/python-setup.js'

function emptyEnv() {
  const home = mkdtempSync(join(tmpdir(), 'rlmh-home-'))
  return { home, env: { RLMH_HOME: home, PATH: join(home, 'nowhere') } } // no uv on PATH
}

test('uv pins cover the platforms rlmh ships, with full SHA-256s', () => {
  assert.deepEqual(Object.keys(UV_ARCHIVES).sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'])
  for (const [archive, sha] of Object.values(UV_ARCHIVES)) {
    assert.match(archive, /^uv-.+\.(tar\.gz|zip)$/)
    assert.match(sha, /^[0-9a-f]{64}$/)
  }
})

test('the question names the folder and the size', () => {
  const text = askText({ RLMH_HOME: '/x/home' })
  assert.match(text, /\/x\/home/)
  assert.match(text, /50 MB to download, 150 MB on disk/)
})

test('a platform with no uv pin and no uv cannot install', () => {
  const { home, env } = emptyEnv()
  assert.equal(canInstall(env, 'linux-arm64'), false)
  assert.equal(canInstall(env, 'linux-x64'), true)
  rmSync(home, { recursive: true, force: true })
})

test('a uv archive with the wrong SHA-256 is refused and nothing is installed', async () => {
  const { home, env } = emptyEnv()
  const urls = []
  const download = async (url, file) => { urls.push(url); writeFileSync(file, 'not uv') }
  await assert.rejects(installPython({ env, download, platform: 'linux-x64' }), /expected f29c3e94.*nothing was installed/)
  assert.deepEqual(urls, ['https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-unknown-linux-gnu.tar.gz'])
  assert.equal(existsSync(join(home, 'bin')), false)
  rmSync(home, { recursive: true, force: true })
})

test('a platform with no uv pin says so', async () => {
  const { home, env } = emptyEnv()
  await assert.rejects(installPython({ env, download: async () => {}, platform: 'linux-arm64' }), /no uv download for linux-arm64/)
  rmSync(home, { recursive: true, force: true })
})
