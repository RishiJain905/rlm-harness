# Releasing rlmh-dsh (v1.1, step 9)

`rlmh-dsh` is the npm package for RLM mode in DeepSeek Harness. It is built from `dsh-plugin/` on branch `dsh-plugin` and never from `main` (D-264, D-265).

Each item below needs Rishi's OK:
- every publish;
- every `workflow_dispatch` run;
- any change on npmjs.com.

## What is ready (2026-11-08)

- **The package.** Version 1.1.0, unscoped name `rlmh-dsh`, about 34 kB, 15 files.
  - It includes a README for npm and the MIT LICENSE.
  - It is no longer `private`.
  - Its peer ranges on dsh packages follow `engines.dsh` (`>=0.2.2-rc.1 <0.3.0`) instead of pinning `0.2.2-rc.1`, so a dsh update within 0.2.x doesn't break the install.
- **Checked on the packed file:**
  - the cache guard passes on a throwaway headless profile;
  - a fresh `web` profile starts with it and shows the RLM mode settings card and the installed plugin.
- **`.github/workflows/dsh-plugin-npm.yml`**, run by dispatch from branch `dsh-plugin`.
  - **Pack job:** runs the tests, packs the package, installs the packed file into a clean dsh profile and runs the cache guard on it, then uploads the tarball.
  - **Publish job:** runs only with `publish=true` from `dsh-plugin`, in the `npm` environment (its reviewer approves). It uses trusted publishing with provenance and skips a version that is already on npm.
- **`dsh-plugin/scripts/market-index.mjs`.** Writes `dsh-plugin/market/index.json`, a dsh plugin index (format 1), checked by dsh's own validator.
  - Run it after a version is on npm: it reads the publish time from npm.

## First release (one time)

npm sets up trusted publishing per package, and only once the package exists. So the first version goes up by hand, the way rlm-harness's packages did (npm-install.md step 4).

1. **Pack and check in CI, without publishing:**

   ```bash
   gh workflow run dsh-plugin-npm.yml --ref dsh-plugin
   ```

   Then download the run's `rlmh-dsh-tarball` artifact.
2. **Publish that file by hand,** logged in to npm as the account that owns the `rlmh` org:

   ```bash
   npm publish ./rlmh-dsh-1.1.0.tgz --access public
   ```

   If npm refuses the name as too similar to an existing package (as it refused `rlmh`, D-151), the fallback is `@rlmh/dsh`, in the existing org. Renaming means changing:
   - `package.json`'s `name`;
   - the `rlmh-dsh` rows and paths in `cordis.patch.yml`;
   - the cache guard's checks;
   - the README.
3. **Turn on trusted publishing.** On npmjs.com, open `rlmh-dsh` → Settings, and add a GitHub Actions trusted publisher:
   - owner `RishiJain905`, repository `rlm-harness`, workflow `dsh-plugin-npm.yml`, environment `npm`;
   - under Allowed actions, tick direct `npm publish`.
   - A new configuration expires unless it publishes within 2 days. If it expires, add it again just before the next release.
4. **Allow the branch in the environment.** If the `npm` environment limits deployment branches, add `dsh-plugin`.
5. **Write the plugin index:**
   - In `dsh-plugin/`, run `node scripts/market-index.mjs`, then commit `market/index.json`.
   - Users add `https://raw.githubusercontent.com/RishiJain905/rlm-harness/dsh-plugin/dsh-plugin/market/index.json` under Plugins → Discover → Index sources. Discover is dsh's experimental "Custom plugin indexes" plugin, which users turn on first.
6. **Add the `dsh-plugin` topic** to the GitHub repository, so people can find it.

## Later releases

1. Bump `version` in `dsh-plugin/package.json`. Run `npm install --package-lock-only`.
2. Run the verify gate, then commit and push to `dsh-plugin`.
3. Publish:

   ```bash
   gh workflow run dsh-plugin-npm.yml --ref dsh-plugin -f publish=true
   ```

   Then approve the `npm` environment in that run.
4. Run `node scripts/market-index.mjs` in `dsh-plugin/`, then commit and push `market/index.json`.

Users update with `dsh plugin --profile <name> update rlmh-dsh` (`dsh plugin` passes its arguments to pnpm), or through the desktop app's plugin manager. The desktop route hasn't been checked yet.
