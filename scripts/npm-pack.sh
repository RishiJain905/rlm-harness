#!/usr/bin/env bash
# KV cache: none
# Builds the npm tarballs (D-130) from a folder of release assets. Run from anywhere:
#   scripts/npm-pack.sh <assets folder> <version> <out folder>
# The assets folder holds rlmh-<os>-<arch>[.exe] and SHA256SUMS, as on a GitHub release. Each binary
# is checked against SHA256SUMS, then packed byte for byte into @rlmh/<platform>-<arch> with uv,
# whose archive is downloaded from GitHub and checked against the SHA-256 pinned in install.sh and
# install.ps1 (the one place those hashes live). The rlmh package is packed last. Binaries missing
# from the folder are skipped, so CI can pack one platform; a release packs all four.
# RLMH_UV_ARCHIVES=<folder> uses uv archives already in that folder instead of downloading them.
set -euo pipefail

usage="usage: scripts/npm-pack.sh <assets folder> <version> <out folder>"
assets=$(cd "${1:?$usage}" && pwd)
version=${2:?$usage}
mkdir -p "${3:?$usage}"
out=$(cd "$3" && pwd)
root=$(cd "$(dirname "$0")/.." && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

die() {
  printf 'npm-pack: %s\n' "$*" >&2
  exit 1
}
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

case $version in v*) die "the version has no leading v: $version" ;; esac
uv_version=$(sed -n 's/^UV_VERSION=\(.*\)$/\1/p' "$root/install.sh")
ps_uv_version=$(sed -n "s/^ *\$uvVersion = '\(.*\)'\$/\1/p" "$root/install.ps1")
[ -n "$uv_version" ] && [ "$uv_version" = "$ps_uv_version" ] ||
  die "install.sh pins uv '$uv_version' and install.ps1 pins '$ps_uv_version'"

# uv_pin ARCHIVE: the SHA-256 the installers pin for that uv archive.
uv_pin() {
  case $1 in
    *windows*) sed -n "s/^ *\$uvSha256 = '\([0-9a-f]\{64\}\)'\$/\1/p" "$root/install.ps1" ;;
    *) sed -n "s/^ *${1//./\\.}) echo \([0-9a-f]\{64\}\) ;;\$/\1/p" "$root/install.sh" ;;
  esac
}

# asset_sum NAME: the SHA256SUMS digest for NAME (a leading * on the name is stripped).
asset_sum() {
  tr -d '\r' <"$assets/SHA256SUMS" | awk -v n="$1" '{ f = $2; sub(/^\*/, "", f); if (f == n) { print tolower($1); exit } }'
}

# set_json FILE VERSION NAME [OS CPU LIBC]: fills in a package.json template.
set_json() {
  node -e '
    const fs = require("fs");
    const [file, version, name, os, cpu, libc] = process.argv.slice(1);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.version = version;
    if (name) pkg.name = name;
    if (os) { pkg.os = [os]; pkg.cpu = [cpu]; }
    if (libc) pkg.libc = [libc];
    for (const dep of Object.keys(pkg.optionalDependencies || {})) pkg.optionalDependencies[dep] = version;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' "$(native "$1")" "$2" "${3:-}" "${4:-}" "${5:-}" "${6:-}"
}

pack() { (cd "$1" && npm pack --silent --pack-destination "$(native "$out")") | tail -n 1; }

[ -f "$assets/SHA256SUMS" ] || die "no SHA256SUMS in $assets"
host=$(node -p 'process.platform + "-" + process.arch')
packed=0
#        platform     release asset          uv archive                         libc
while read -r platform asset archive libc; do
  [ -f "$assets/$asset" ] || continue
  expected=$(asset_sum "$asset")
  actual=$(sha256_of "$assets/$asset")
  [ -n "$expected" ] || die "SHA256SUMS has no line for $asset"
  [ "$expected" = "$actual" ] || die "$asset: SHA256SUMS says $expected, the file is $actual"

  exe=""
  case $platform in win32-*) exe=.exe ;; esac
  dir="$stage/$platform"
  mkdir -p "$dir/bin" "$stage/uv-$platform"
  cp "$assets/$asset" "$dir/bin/rlmh$exe"
  chmod 755 "$dir/bin/rlmh$exe" # a downloaded artifact loses its mode
  if [ "$platform" = "$host" ]; then
    got=$("$dir/bin/rlmh$exe" --version | tr -d '\r')
    [ "$got" = "rlmh $version" ] || die "$asset --version says '$got', not 'rlmh $version'"
  fi

  if [ -n "${RLMH_UV_ARCHIVES:-}" ]; then
    cp "$RLMH_UV_ARCHIVES/$archive" "$stage/$archive"
  else
    curl -fsSL --retry 3 -o "$stage/$archive" "https://github.com/astral-sh/uv/releases/download/$uv_version/$archive"
  fi
  pin=$(uv_pin "$archive")
  got=$(sha256_of "$stage/$archive")
  [ -n "$pin" ] || die "no pinned SHA-256 for $archive in the installers"
  [ "$pin" = "$got" ] || die "$archive: the installers pin $pin, the download is $got"
  case $archive in
    *.zip) if command -v unzip >/dev/null 2>&1; then unzip -q "$stage/$archive" -d "$stage/uv-$platform"; else tar -xf "$stage/$archive" -C "$stage/uv-$platform"; fi ;;
    *) tar -xzf "$stage/$archive" -C "$stage/uv-$platform" ;;
  esac
  uv=$(find "$stage/uv-$platform" -type f -name "uv$exe" | head -n 1)
  [ -n "$uv" ] || die "$archive holds no file named uv$exe"
  cp "$uv" "$dir/bin/uv$exe"
  chmod 755 "$dir/bin/rlmh$exe" "$dir/bin/uv$exe"

  cp "$root/npm/platform/package.json" "$root/npm/platform/README.md" "$root/npm/platform/uv-LICENSE-MIT" "$dir/"
  cp "$root/LICENSE" "$dir/LICENSE"
  set_json "$dir/package.json" "$version" "@rlmh/$platform" "${platform%-*}" "${platform#*-}" "$([ "$libc" = - ] || echo "$libc")"
  echo "packed $(pack "$dir") from $asset (uv $uv_version)"
  packed=$((packed + 1))
done <<'EOF'
win32-x64    rlmh-windows-x64.exe   uv-x86_64-pc-windows-msvc.zip      -
darwin-arm64 rlmh-darwin-arm64      uv-aarch64-apple-darwin.tar.gz     -
darwin-x64   rlmh-darwin-x64        uv-x86_64-apple-darwin.tar.gz      -
linux-x64    rlmh-linux-x64         uv-x86_64-unknown-linux-gnu.tar.gz glibc
EOF
[ "$packed" -gt 0 ] || die "no rlmh-<os>-<arch> binary in $assets"

dir="$stage/rlmh"
mkdir -p "$dir/bin"
cp "$root/npm/rlmh/package.json" "$root/npm/rlmh/install.js" "$root/npm/rlmh/README.md" "$dir/"
cp "$root/npm/rlmh/bin/rlmh.exe" "$dir/bin/rlmh.exe"
head -c 2 "$dir/bin/rlmh.exe" | grep -q '^#!' && die "the placeholder bin/rlmh.exe must not start with #!"
chmod 755 "$dir/bin/rlmh.exe"
cp "$root/LICENSE" "$dir/LICENSE"
set_json "$dir/package.json" "$version"
echo "packed $(pack "$dir")"
