# Installing rlmh from npm (design, D-130)

> **Status: built 2026-11-01, not published.** Rishi picked the npm route ("Perfect lets go with npm"), opencode-style, then said "Build as designed", which took the recommended choice on each of the four questions at the end. The installed command is the compiled binary, with no launcher. `install.ps1` and `install.sh` stay as they are.
>
> Each of these still needs Rishi's OK: creating the `@rlmh` org and the names, the `npm` environment and the `NPM_PUBLISH` variable, any push, and any publish.
>
> **The package is `rlm-harness`, not `rlmh` (D-151).** npm refused `rlmh` on the first publish ("too similar to existing package rlp"). The command is still `rlmh`, and the platform packages are still `@rlmh/<platform>-<arch>`. Elsewhere in this doc, `rlmh` as a package name (in `npm i -g rlmh`, `bun add -g --trust rlmh`, `bun pm -g trust rlmh`) now means `rlm-harness`.
>
> **v0.1.0 cannot be published to npm.** Its binary predates the `findUv` change, so npm starts at the next release. "As built" at the end lists what differs from the design.

## Goal

`npm i -g rlmh` and `bun add -g --trust rlmh` put an `rlmh` command on PATH that **is** the compiled binary built by `release.yml`. It is never `app/src/main.ts`, never TypeScript, and never a JavaScript launcher. After that, first run works exactly as it does after the install scripts: the same question, Python 3.12 into `<home>/python/`, and the engine into `<home>/engine/<version>/`.

## What was measured (Windows 11, Node 24.15, npm 11.7, Bun 1.4.4)

Each probe was run from a folder holding a `.env` (`PROBE_KEY=…`) and a `bunfig.toml` whose `preload` prints a line. `whoami.exe` stood in for `rlmh.exe`.

| Probe | Result |
|---|---|
| A bin that is a `#!/usr/bin/env node` script, run by Bun's global shim or by `bunx` | Runs under Node when Node is on PATH. With no Node on PATH it runs under **Bun**, which loads the `.env` and runs the preload before the script's first line. |
| A bin that is a native `.exe`, `npm i -g` | npm's cmd-shim has no shebang to follow, so it runs the file directly: `"%dp0%\node_modules\<pkg>\bin\rlmh.exe" %*`. No Node, no preload. |
| A bin that is a native `.exe`, `bun add -g` (with and without Node on PATH) | Bun's shim starts it directly. No preload, no `.env`. |
| A placeholder bin with no shebang, plus a `postinstall` that copies the `.exe` over it, `npm i -g` | npm ran the `postinstall` for the global package, and the bin started the real `.exe` directly. |
| The same package, `bun add -g` | Bun said "Blocked 1 postinstall". The bin then failed with Bun's "could not create process … corrupted node_modules" message. |
| The same package, `bun add -g --trust`, or `bun pm -g trust <pkg>` afterwards | The `postinstall` ran, and the bin started the real `.exe` directly. |
| `pnpm add -g` | Not measured: pnpm 11.14 refused a scratch global bin folder from Git Bash. |

The parent session also found that `bun --no-env-file --config=<path> main.ts` blocks both the `.env` and the preload, but `-c <path>` (with a space) does not. This design starts no Bun process, so it doesn't need that.

**The conclusion.** A package's `bin` is one path for every OS, so the native binary for this machine has to be put at that path when the package is installed. npm does that through a `postinstall`. Bun does it only for packages the user trusts, so the Bun command is `bun add -g --trust rlmh`. There is no way around this that keeps "starts the binary directly": a JavaScript launcher would run under Bun on a machine with no Node, and Bun's shim cannot be pointed at a file in another package.

## Shape

| Package | Holds | Fields |
|---|---|---|
| `rlmh` | `bin/rlmh.exe` (a placeholder, replaced at install), `install.js`, `LICENSE`, `README.md` | `bin: {"rlmh": "bin/rlmh.exe"}`; `scripts.postinstall: "node install.js"`; `optionalDependencies` on the four packages below at exactly the same version; no other dependencies |
| `@rlmh/win32-x64` | `bin/rlmh.exe`, `bin/uv.exe`, licences | `os: ["win32"]`, `cpu: ["x64"]` |
| `@rlmh/darwin-arm64` | `bin/rlmh`, `bin/uv`, licences | `os: ["darwin"]`, `cpu: ["arm64"]` |
| `@rlmh/darwin-x64` | `bin/rlmh`, `bin/uv`, licences | `os: ["darwin"]`, `cpu: ["x64"]` |
| `@rlmh/linux-x64` | `bin/rlmh`, `bin/uv`, licences | `os: ["linux"]`, `cpu: ["x64"]`, `libc: ["glibc"]` |

- The platform package names follow `${process.platform}-${process.arch}`. Each `bin/rlmh[.exe]` is the release asset byte for byte, checked against the release's `SHA256SUMS` before packing.
- The bin target is `bin/rlmh.exe` on every OS. On Unix, npm and Bun link the command as `rlmh`, so the file's name does not matter there. On Windows, the `.exe` name is what makes Windows run the file.
- All five packages share `APP_VERSION`. A tag with `-` (an rc) publishes with `--tag next`, so `latest` never moves to an rc.

### `install.js` (the postinstall)

- Plain CommonJS with Node built-ins only. npm runs it under Node. Bun runs `node install.js` under Node when Node is on PATH, and otherwise under Bun acting as `node`.
- Either way its working folder is the `rlmh` package folder, which holds no `.env` and no `bunfig.toml`. It runs once, at install, and is not on the path `rlmh` takes at run time.
- **What it does.** It finds `@rlmh/<platform>-<arch>/package.json` with `require.resolve`. It then hard-links that package's `bin/rlmh[.exe]` and `bin/uv[.exe]` into `rlmh/bin/` as `rlmh.exe` and `uv[.exe]`, falling back to a copy when a hard link fails. It writes each one to a temp name and renames it into place, sets mode 0755 on Unix, and on macOS keeps the binary's ad hoc signature, since a copy carries it.
- **Linking uv as well** puts uv beside the running binary, which is where `findUv` looks (see "First-run Python setup").
- **It fails loudly, not silently.**
  - An unsupported platform gets the installers' `rlmh v0 ships …` line. Linux musl is detected from `process.report`'s `glibcVersionRuntime`.
  - A missing platform package gets "reinstall without `--omit=optional`".
  - Any failure exits non-zero, so npm reports the install as failed.

### The placeholder `bin/rlmh.exe`

- It must not start with `#!`. A shebang would make npm's Windows cmd-shim generate a `node …` or `sh …` shim at link time, and that shim would still be used after the real binary replaced the file.
- On Unix it is a short POSIX `sh` script with no shebang. When the postinstall did not run (`bun add -g` without `--trust`, or `npm --ignore-scripts`), the kernel refuses the file. The shell, or `execvp` in libc and libuv, then runs it with `/bin/sh`. The script finds `@rlmh/<platform>-<arch>/bin/rlmh` next to the `rlmh` package and `exec`s it, so Unix keeps working with no Node and no Bun. It also prints one line to stderr: `rlmh: the install step did not run; "bun pm -g trust rlmh" makes this permanent.`
- **On Windows there is no fallback.** A file that is not a real `.exe` cannot print anything. Without the postinstall, npm says "not a valid Win32 application" and Bun says "could not create process". The README and release notes give the Bun command as `bun add -g --trust rlmh` on every OS, plus `bun pm -g trust rlmh` as the repair. With `--trust`, Bun records `rlmh` in its global `trustedDependencies`, so later upgrades run the step without asking again.

### D-44, point by point

- **The command is the compiled binary,** built with `--no-compile-autoload-dotenv --no-compile-autoload-bunfig` as today. No Bun or Node runtime sits between the shell and `rlmh`.
- **The only JavaScript is `install.js`,** at install time, in the package's own folder.
- **What stays a caveat** (README):
  - `npm i -g` and `bun add -g` read the current folder's `.npmrc` or `bunfig.toml` `[install]` settings, a registry override included. Install from a folder you trust, not from inside a repo you just cloned. That is how those tools work, not something rlmh adds.
  - `npx rlmh` works, because npx runs the postinstall.
  - `bunx rlmh` blocks the postinstall: on Unix the `sh` fallback still works, but on Windows it fails. So `bunx` isn't documented.

## First-run Python setup

`runSetup` and `ensureEngine` don't change. Only **where uv is found** does:

- Each platform package carries uv `0.13.6`, the version the installers pin. The pack script downloads the uv archive from GitHub and checks it against the SHA-256 already pinned in `install.sh` (`uv_sha256`) and `install.ps1`, which stay the one place those hashes live. The package also carries uv's `LICENSE-MIT` (uv is MIT or Apache-2.0).
- `findUv` gains one step: `<home>/bin/uv[.exe]`, then **the folder holding the running compiled binary** (`dirname(process.execPath)`, only when compiled), then PATH.
  - In the installer layout, that folder is `<home>/bin`, so nothing changes.
  - After the postinstall, it is `rlmh/bin/`, where `install.js` linked uv.
  - In the Unix `sh` fallback, it is the platform package's `bin/`, which holds uv too.
- **Everything else is as before.** The question is asked once, and `uv python install 3.12` runs with the same `UV_*` env into `<home>/python/`. The engine goes to `<home>/engine/<APP_VERSION>/`, and `.installed.json` stays the one place that names the Python. An upgrade to a new version extracts the new engine with no question and no network (D-125).
- **Uninstall.** `npm rm -g rlmh` or `bun rm -g rlmh` removes the binary and uv. `<home>` stays (Python, engines, settings, run logs), so the README says to delete it too, and to delete saved keys in `/providers` first.
- **Windows upgrades.** npm cannot replace a running `rlmh.exe` (EBUSY), so close `rlmh` before upgrading.
- **Size.** Each platform package holds about 120 MB of `rlmh` and about 60 MB of uv, unpacked (measured on Windows). Hard links keep the installed copy from doubling that. The packed size gets measured at build.

## Names and scope (Rishi's call)

- **`rlmh`**: the package users type, unscoped. Free on npm on 2026-10-31.
- **`@rlmh/<platform>-<arch>`** (recommended): needs an npm org named `rlmh`, which is free for public packages and created by Rishi on npmjs.com. One scope covers every future platform, so nobody can squat a name beside ours. I could not check whether the org name is taken without logging in.
- **Alternatives:**
  - opencode's form, `rlmh-<platform>-<arch>`: unscoped, so four more names to claim.
  - `@<Rishi's npm user>/rlmh-<platform>-<arch>`: needs no org.

## What `release.yml` gets

`release.yml` publishes the GitHub release with `GITHUB_TOKEN`, and a release made that way does not trigger other workflows. So the npm step is a **reusable workflow**. `release.yml` calls it after `publish`, and Rishi can also start it by hand for an existing tag. That is how `v0.1.0` would reach npm without re-tagging.

- **`.github/workflows/npm.yml`** (`workflow_call` and `workflow_dispatch`; inputs `tag`, and `publish`, a boolean that defaults to `false` for dispatch):
  1. `gh release download <tag>` into `dist/`, then `sha256sum -c SHA256SUMS`. The npm binaries are the release assets, not a rebuild.
  2. `scripts/npm-pack.sh dist <version> out/` builds the five tarballs from templates in `npm/`: `npm/rlmh/{package.json,install.js,bin/rlmh.exe}` and `npm/platform/package.json`. The version is the tag without `v`, and it must equal `rlmh --version` on the Linux runner.
  3. It installs from those tarballs through a throwaway local registry (Verdaccio on `127.0.0.1`), so the optional dependencies resolve the way they would from npm, then runs `rlmh --version`.
  4. It uploads the tarballs as an artifact.
  5. Only when `publish` is true, in a GitHub **environment `npm`** with Rishi as required reviewer (one click per publish), it publishes the four platform tarballs, then `rlmh` last. It uses `--access public --provenance`, plus `--tag next` for an rc. A version already on npm is skipped, so a re-run after a partial failure finishes the job.
- **`release.yml`** gets one new job: `npm: needs: publish, uses: ./.github/workflows/npm.yml, with: {tag: <ref>, publish: true}`. It runs only on a tag, and the environment's reviewer gate still applies.
- **Auth (recommended): npm trusted publishing.** The job gets `id-token: write`, and npm 11.5.1 or later trades GitHub's OIDC token for a one-time credential, so no `NPM_TOKEN` is stored anywhere.
  - npm sets trusted publishing per package on npmjs.com, and the package must exist first. So there is a one-time bootstrap: Rishi publishes the five tarballs from a `publish: false` run's artifact by hand, then turns on trusted publishing for each package.
  - npm checks the **calling** workflow's name, so tag runs need `release.yml` registered and dispatch runs need `npm.yml` (a package can have up to 10).
  - A new configuration expires unless it completes a successful publish within 2 days, so `release.yml` is registered just before a tag that will publish, and `npm.yml` only when a dispatch publish is planned.
  - Trusted publishing needs Node 22.14 or later and npm 11.5.1 or later, so the publish job installs Node 24 and npm 11.7.0.
  - **Alternative:** a granular `NPM_TOKEN` (publish rights on these packages only, short expiry), stored as a secret of the `npm` environment, not of the repo.

## Tests

- **`app/test/npm.test.ts`**, run by `bun test`, so the gate runs it. It runs `install.js` under `node` in a temp `node_modules` layout, with the platform package holding stand-ins (a copy of `whoami.exe`, or a small script on Unix). It checks:
  - `rlmh/bin/rlmh.exe` and `uv[.exe]` become the platform files: same bytes, and a hard link where possible.
  - A missing platform package fails with the `--omit=optional` message, and an unsupported platform with the `rlmh v0 ships` line. `install.js` exports its resolver when `require`d.
  - The placeholder has no `#!`.
  - On Unix, running the placeholder through `sh` execs the platform binary.
  - The file is skipped only where `node` is not on PATH.
- **`setup.test.ts`**: `findUv` finds uv beside the binary after `<home>/bin` and before PATH. This needs a test seam for the binary's folder, in the style of D-124.
- **CI**: an `npm` job on the three OSes, after `build`, using that build's artifact.
  - It runs `npm-pack.sh` with a `SHA256SUMS` it writes itself, and installs through Verdaccio with `npm i -g`, `bun add -g --trust`, and plain `bun add -g`. Plain `bun add -g` must work on Unix through the fallback, and on Windows it is expected to fail as documented.
  - It checks that the command's target is the binary itself: on Windows, the shim names `bin\rlmh.exe` and has no `node`; on Unix, the link resolves to a Mach-O or ELF file.
  - It runs `rlmh --version`, `rlmh setup --yes` with no uv on PATH and no `<home>/bin/uv` (proving the bundled uv was used), and the fake-provider question from `scripts/install-check.sh`.
  - It runs from a folder with a `.env` and a preload `bunfig.toml`, and checks that neither is read.

## Files the build touched

- **New:** `npm/` (templates), `scripts/npm-pack.sh`, `scripts/npm-check.sh`, `.github/workflows/npm.yml`, `app/test/npm.test.ts`.
- **Changed:** `release.yml` (+1 job), `ci.yml` (+`npm` job), `app/src/cli/setup.ts` (`findUv`), `app/test/setup.test.ts`, `architecture.md` §7.10 (the `findUv` line and the packages), `README.md` (install section and caveats), and `decisions.md` D-130 (from proposed to built).

## Choices for Rishi

1. **Scope:**
   - `@rlmh` org (recommended).
   - Unscoped `rlmh-<platform>-<arch>`, opencode's form.
   - Your user scope.
2. **uv:**
   - (a) Bundle uv 0.13.6 in each platform package (recommended: no new network code in `rlmh`, and the hash is checked once, at release).
   - (b) Have first run download the pinned uv into `<home>/bin/`: smaller packages, but download code in `setup.ts` and a third copy of the hashes.
   - (c) Ship no uv: npm users would be stuck on first run.
3. **Bun's trust step:**
   - Document `bun add -g --trust rlmh` and ship the Unix `sh` fallback (recommended).
   - Or skip the fallback, so plain `bun add -g` fails on every OS until trusted.
4. **Publish auth:**
   - Trusted publishing with a one-time manual bootstrap (recommended).
   - Or a scoped `NPM_TOKEN` in the `npm` environment.

## As built (2026-11-01)

**What differs from the design:**

- **musl detection.** `install.js` looks for musl's loader (`/lib/ld-musl-*`) instead of reading `process.report`, so the check works under Bun acting as `node` too.
- **The checks live in a script.** `scripts/npm-check.sh <tarballs> <assets> [--quick]` holds them, and both CI and `npm.yml` run it.
  - It installs Verdaccio 6.10.5 into a temp folder. 7.0.2 was under two weeks old.
  - `--quick` stops after the install checks, and `npm.yml` uses it.
- **Publishing needs a variable.** `release.yml`'s `npm` job packs on every tag but publishes only when the repo variable `NPM_PUBLISH` is `1`, and only after the `npm` environment's reviewer approves. The repo publishes nothing until Rishi sets both up.
- **`npm.yml` checks out the tag.** The templates then match the release. v0.1.0 has no `npm/`, so it cannot be packed; it shouldn't be, because of the `findUv` change.

**Checked on Rishi's PC** (Windows 11, Node 24.15, npm 11.7, Bun 1.4.4), in a temp folder:

- `npm-pack.sh` on the real v0.1.0 assets:
  - It checked `rlmh-windows-x64.exe` against `SHA256SUMS`, and uv's zip against `install.ps1`'s pin.
  - `@rlmh/win32-x64` packed to 71,499,053 bytes (rlmh 119,559,680 and uv 31,803,184 unpacked), and `rlmh` to 3,873.
- The full `npm-check.sh` on a binary built from this branch, run with no uv on PATH:
  - `npm i -g` and `bun add -g --trust` from Verdaccio each gave an `rlmh` whose target is the binary byte for byte, and npm's `rlmh.cmd` starts `bin
lmh.exe` with no `node`.
  - `rlmh --version` run from a folder with a `.env` and a preload `bunfig.toml` printed no preload line.
  - Plain `bun add -g` failed on Windows, as documented.
  - `rlmh setup --yes` fetched CPython 3.12.16 with the bundled uv (no `<home>/bin/uv`), `rlmh info` was right, and the fake-provider question completed.
- On the v0.1.0 binary, the same setup said "uv was not found", which is the reason npm starts at the next release.
- The Unix `sh` fallback ran in Git Bash with a stand-in `uname`, in both the nested and the beside layouts.

**Not checked yet:**

- CI on Linux and macOS: the `npm` job, and the `sh` fallback tests in `npm.test.ts`.
- `npm.yml` itself.
- Any real publish.

## Setting up publishing (once)

1. **The npm org.** Create `rlmh` on npmjs.com. (Done 2026-11-01, by `trjxter`.)
2. **The GitHub environment.**
   - In the repo, go to **Settings → Environments → New environment** and name it `npm`.
   - Under **Deployment protection rules**, tick **Required reviewers** and add yourself.
   - Leave **Prevent self-review** unticked: you push the tags, and that option would stop you approving your own run.
   - Optionally, under **Deployment branches and tags**, choose **Selected branches and tags** and add the tag rule `v*` (the `npm.yml` dispatch runs on a branch, so add `main` too).
3. **The first publish, by hand.** After the first release that holds `npm/` (v0.1.1):
   1. Download the `npm-tarballs` artifact from that release run's `npm` job, or from a `publish: false` dispatch of `npm.yml`.
   2. Run `npm publish ./<file> --access public` (the `./` matters: without it npm reads `out/x.tgz` as a GitHub repo, D-167) for the four `rlmh-<platform>-*.tgz` files, then for `rlmh-<version>.tgz`.
4. **Trusted publishing, within 2 days of the next tag.** A new trusted-publisher configuration expires if it has not published successfully within 2 days, so do this step just before tagging the release after v0.1.1.
   - On each of the five packages' **Settings** page on npmjs.com, add a GitHub Actions trusted publisher: owner `RishiJain905`, repository `rlm-harness`, workflow `release.yml` (npm checks the calling workflow), environment `npm`, and under **Allowed actions** tick direct `npm publish` (only `npm stage publish` is allowed by default, and `npm.yml` runs `npm publish`). The five packages are `rlm-harness` and the four `@rlmh/<platform>-<arch>`. npm checks none of these fields when you save, and they are case-sensitive, so a typo shows only as a failed publish.
   - Add `npm.yml` the same way only when you plan to publish through a dispatch run.
   - Once a CI publish has worked, npm can be set to disallow token publishing.
5. **Turn it on.** Set the repo variable `NPM_PUBLISH` to `1` (**Settings → Secrets and variables → Actions → Variables**), then push the tag. From then on each tag publishes after the `npm` environment's approval.

**How it actually runs (D-263, since 1.0.0).** The packages' trusted publisher is `npm.yml`, not `release.yml`, so a tag run packs and checks only (`release.yml` passes `publish: false`). After the release is out, publish with a dispatch: `gh workflow run npm.yml --ref main -f tag=vX.Y.Z -f publish=true`, then approve the `npm` environment in that run. To let tag runs publish again, register `release.yml` on all five packages as in step 4 and set `publish:` in `release.yml` back to `${{ vars.NPM_PUBLISH == '1' }}`.
