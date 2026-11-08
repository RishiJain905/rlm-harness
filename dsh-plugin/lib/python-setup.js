// KV cache: none (runs outside any model request; the agent sees its messages only as a failed run_code result)
// D-264 step 5b: Python 3.12 for RLM mode on installs without dsh desktop's bundled CPython, fetched through uv the
// way `rlmh setup` does it and into the same places, so the two share it: uv in <home>/bin (only when uv isn't on
// PATH), Python in <home>/python, where <home> is RLMH_HOME or ~/.rlm-harness. The runtime asks the user before
// calling installPython (lib/rlm-runtime.js). Every function here takes an env already stripped of key-like names.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const UV_VERSION = '0.13.6'

// uv's release archive and its SHA-256 per platform: the same pins as install.sh and install.ps1.
export const UV_ARCHIVES = Object.freeze({
  'darwin-arm64': ['uv-aarch64-apple-darwin.tar.gz', '60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472'],
  'darwin-x64': ['uv-x86_64-apple-darwin.tar.gz', '63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02'],
  'linux-x64': ['uv-x86_64-unknown-linux-gnu.tar.gz', 'f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645'],
  'win32-x64': ['uv-x86_64-pc-windows-msvc.zip', 'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f'],
})

const UV_EXE = process.platform === 'win32' ? 'uv.exe' : 'uv'

export function rlmhHome(env) {
  return env.RLMH_HOME || join(homedir(), '.rlm-harness')
}

/** uv in <home>/bin, else uv on PATH; undefined when neither runs. */
export function findUv(env) {
  const own = join(rlmhHome(env), 'bin', UV_EXE)
  for (const bin of [own, 'uv']) {
    try {
      if (spawnSync(bin, ['--version'], { timeout: 10_000, windowsHide: true, env }).status === 0) return bin
    } catch {}
  }
  return undefined
}

/** The uv settings that keep its Pythons in <home>/python and off the user's PATH and registry (as `rlmh setup`). */
function uvPythonEnv(env) {
  const dir = join(rlmhHome(env), 'python')
  return { ...env, UV_PYTHON_INSTALL_DIR: dir, UV_PYTHON_BIN_DIR: join(dir, 'bin'), UV_PYTHON_INSTALL_BIN: '0', UV_PYTHON_INSTALL_REGISTRY: '0' }
}

/** The Python 3.12 in <home>/python (put there by this file or by `rlmh setup`); undefined when none. Never downloads. */
export function homePython(env) {
  const uv = findUv(env)
  if (!uv) return undefined
  try {
    const r = spawnSync(uv, ['python', 'find', '3.12'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { ...uvPythonEnv(env), UV_MANAGED_PYTHON: '1', UV_PYTHON_DOWNLOADS: 'never' },
    })
    const path = (r.stdout ?? '').trim().split(/\r?\n/).pop()
    return r.status === 0 && path ? path : undefined
  } catch {
    return undefined
  }
}

/** Whether installPython can work here: uv is already available, or this platform has a pinned uv archive. */
export function canInstall(env, platform = `${process.platform}-${process.arch}`) {
  return Boolean(UV_ARCHIVES[platform] || findUv(env))
}

/** What the user is asked before anything is downloaded. */
export function askText(env) {
  const home = rlmhHome(env)
  return `RLM mode runs code in Python 3.12, and this computer has none it can use. Download it now? `
    + `This fetches a standalone Python 3.12 through uv (about 50 MB to download, 150 MB on disk; uv ${UV_VERSION} comes `
    + `from github.com/astral-sh/uv first, checked against a pinned SHA-256, when it isn't installed) into ${home}. Nothing else on this computer changes.`
}

/** Runs argv; resolves with its exit code and the end of its stderr. Rejects on abort. */
function run(argv, { env, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { env, signal, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr = (stderr + d).slice(-2000) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr: stderr.trim() }))
  })
}

/** Downloads url to file with curl (in Windows 10+, macOS and Linux; it honours HTTPS_PROXY, unlike Node's fetch). */
async function curl(url, file, opts) {
  const r = await run(['curl', '-fsSL', '--retry', '2', '-o', file, url], opts)
  if (r.code !== 0) throw new Error(`downloading ${url} failed (curl exited ${r.code}${r.stderr ? `: ${r.stderr}` : ''})`)
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      const found = findFile(path, name)
      if (found) return found
    } else if (entry === name) {
      return path
    }
  }
  return undefined
}

/** Puts uv ${UV_VERSION} in <home>/bin from its GitHub release, checked against the pinned SHA-256. Returns its path. */
async function fetchUv(env, signal, download, platform) {
  const pin = UV_ARCHIVES[platform]
  if (!pin) throw new Error(`there is no uv download for ${platform}; install uv or Python 3.12 yourself`)
  const [archive, sha256] = pin
  const tmp = mkdtempSync(join(tmpdir(), 'rlmh-uv-'))
  try {
    const file = join(tmp, archive)
    await download(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${archive}`, file, { env, signal })
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
    if (actual !== sha256) throw new Error(`${archive} has SHA-256 ${actual}, expected ${sha256}; nothing was installed`)
    const out = join(tmp, 'x')
    mkdirSync(out)
    // tar reads .zip too on Windows 10+ (bsdtar), and .tar.gz everywhere
    const untar = await run(['tar', '-xf', file, '-C', out], { env, signal })
    if (untar.code !== 0) throw new Error(`could not unpack ${archive} (tar exited ${untar.code}${untar.stderr ? `: ${untar.stderr}` : ''})`)
    const found = findFile(out, UV_EXE)
    if (!found) throw new Error(`${archive} holds no ${UV_EXE}`)
    const bin = join(rlmhHome(env), 'bin')
    mkdirSync(bin, { recursive: true })
    const dest = join(bin, UV_EXE)
    copyFileSync(found, dest)
    chmodSync(dest, 0o755)
    return dest
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Installs Python 3.12 into <home>/python through uv (fetching uv first when there is none) and returns its path.
 * Throws an Error whose message says what failed. `download` and `platform` are for tests.
 */
export async function installPython({ env, signal, download = curl, platform = `${process.platform}-${process.arch}` }) {
  const uv = findUv(env) ?? await fetchUv(env, signal, download, platform)
  const r = await run([uv, 'python', 'install', '3.12'], { env: uvPythonEnv(env), signal })
  if (r.code !== 0) throw new Error(`uv could not install Python 3.12 (exit ${r.code}${r.stderr ? `: ${r.stderr}` : ''})`)
  const python = homePython(env)
  if (!python) throw new Error('uv installed Python 3.12, but `uv python find 3.12` did not report it')
  return python
}
