// KV cache: none
// rlmh's postinstall (D-130). Links this platform's compiled rlmh and uv from the optional dependency
// @rlmh/<platform>-<arch> over the placeholder bin/rlmh.exe and into bin/, so the `rlmh` command npm
// or Bun linked at install time is the compiled binary itself, with no Node or Bun in between. It runs
// once, at install, with the package folder as its working folder; rlmh never runs it again.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PLATFORMS = ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"];
const UNSUPPORTED = "rlmh v0 ships macOS arm64 and x64, Windows x64 and Linux x64 (glibc).";

/** True on a musl Linux such as Alpine: its loader sits in /lib. Works under Node and under Bun as node. */
function isMusl() {
  try {
    return fs.readdirSync("/lib").some((f) => f.startsWith("ld-musl-"));
  } catch {
    return false;
  }
}

/** "<platform>-<arch>", or throws the installers' unsupported-platform message. */
function platformKey(platform, arch, musl) {
  const key = `${platform}-${arch}`;
  if (!PLATFORMS.includes(key) || (platform === "linux" && musl)) {
    throw new Error(`${UNSUPPORTED} This machine is ${platform} ${arch}${platform === "linux" && musl ? " (musl)" : ""}.`);
  }
  return key;
}

/** The folder of @rlmh/<key>, or throws when npm or Bun did not install it. */
function packageDir(key, resolve) {
  const name = `@rlmh/${key}`;
  try {
    return path.dirname(resolve(`${name}/package.json`));
  } catch {
    throw new Error(`${name} is not installed. Reinstall without --omit=optional or --no-optional: npm i -g rlm-harness`);
  }
}

/** Hard-links src to dest (a copy where a link fails), through a temp name so dest is never half-written. */
function place(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`${src} is missing from its package`);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  try {
    fs.linkSync(src, tmp);
  } catch {
    fs.copyFileSync(src, tmp);
  }
  if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
  fs.rmSync(tmp, { force: true }); // rename leaves tmp when dest was already a link to the same file (a re-run)
}

/** Puts rlmh and uv from the platform package into <root>/bin. */
function install(opts) {
  const key = platformKey(opts.platform, opts.arch, opts.musl);
  const from = path.join(packageDir(key, opts.resolve), "bin");
  const to = path.join(opts.root, "bin");
  const exe = opts.platform === "win32" ? ".exe" : "";
  place(path.join(from, `uv${exe}`), path.join(to, `uv${exe}`));
  place(path.join(from, `rlmh${exe}`), path.join(to, "rlmh.exe")); // the bin target on every OS
  return key;
}

module.exports = { PLATFORMS, UNSUPPORTED, platformKey, packageDir, place, install };

if (require.main === module) {
  try {
    install({
      platform: process.platform,
      arch: process.arch,
      musl: process.platform === "linux" && isMusl(),
      resolve: require.resolve,
      root: __dirname,
    });
  } catch (err) {
    console.error(`rlmh: ${err.message}`);
    process.exit(1);
  }
}
