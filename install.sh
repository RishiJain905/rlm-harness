#!/bin/sh
# KV cache: none
# Installs rlmh on macOS (arm64, x64) and Linux (x64, glibc) into <home>/bin (step 10):
#   curl -fsSL https://github.com/RishiJain905/rlm-harness/releases/latest/download/install.sh | sh
# Inputs, from the environment only:
#   RLMH_VERSION         latest (default), 0.1.0 or v0.1.0
#   RLMH_HOME            <home>, default ~/.rlm-harness
#   RLMH_DOWNLOAD_BASE   a folder holding rlmh-<os>-<arch> and SHA256SUMS, used as given
#   RLMH_NO_MODIFY_PATH  1 leaves every shell rc file alone
# It installs uv into <home>/bin only when uv is not on PATH. Python and the engine come later,
# from "rlmh setup" on first run. The checksums catch a corrupted download, not a compromised
# release.
set -eu

UV_VERSION=0.13.6
REPO_URL=https://github.com/RishiJain905/rlm-harness
UNSUPPORTED='rlmh v0 ships macOS arm64 and x64, Windows x64 and Linux x64 (glibc).'

# Set by main; read by cleanup.
TMP_DIR=
MADE_HOME=
MADE_BIN=
DONE=

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'rlmh install: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  if [ -z "$DONE" ]; then
    # rmdir removes only folders this run made and left empty.
    if [ -n "$MADE_BIN" ]; then
      rmdir "$MADE_BIN" 2>/dev/null || true
    fi
    if [ -n "$MADE_HOME" ]; then
      rmdir "$MADE_HOME" 2>/dev/null || true
    fi
  fi
}

# The SHA-256 of each uv $UV_VERSION archive, copied from that release's <archive>.sha256 files.
uv_sha256() {
  case "$1" in
    uv-aarch64-apple-darwin.tar.gz) echo 60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472 ;;
    uv-x86_64-apple-darwin.tar.gz) echo 63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02 ;;
    uv-x86_64-unknown-linux-gnu.tar.gz) echo f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645 ;;
    *) return 1 ;;
  esac
}

unsupported() {
  printf '%s This machine is %s.\n' "$UNSUPPORTED" "$(uname -sm 2>/dev/null || echo unknown)" >&2
  exit 1
}

is_musl() {
  for f in /lib/ld-musl-* /usr/lib/ld-musl-*; do
    if [ -e "$f" ]; then
      return 0
    fi
  done
  if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    return 0
  fi
  return 1
}

# Sets OS, ARCH and UV_TRIPLE, or exits with the unsupported message.
detect_platform() {
  kernel=$(uname -s 2>/dev/null || echo unknown)
  machine=$(uname -m 2>/dev/null || echo unknown)
  case "$kernel" in
    Darwin)
      OS=darwin
      case "$machine" in
        arm64 | aarch64) ARCH=arm64 ;;
        x86_64)
          # Apple Silicon under Rosetta reports x86_64; the arm64 binary is the right one.
          if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
            ARCH=arm64
          else
            ARCH=x64
          fi
          ;;
        *) unsupported ;;
      esac
      if [ "$ARCH" = arm64 ]; then
        UV_TRIPLE=aarch64-apple-darwin
      else
        UV_TRIPLE=x86_64-apple-darwin
      fi
      ;;
    Linux)
      OS=linux
      case "$machine" in
        x86_64 | amd64) ARCH=x64 ;;
        *) unsupported ;;
      esac
      if is_musl; then
        unsupported
      fi
      UV_TRIPLE=x86_64-unknown-linux-gnu
      ;;
    *) unsupported ;;
  esac
}

# download URL FILE
download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1" || die "could not download $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || die "could not download $1"
  else
    die "needs curl or wget to download $1"
  fi
}

# sha256_of FILE: prints the lower-case hex digest.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(sha256sum "$1" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(shasum -a 256 "$1" | awk '{print $1}')
  elif command -v openssl >/dev/null 2>&1; then
    digest=$(openssl dgst -sha256 "$1" | awk '{print $NF}')
  else
    die "needs sha256sum, shasum or openssl to check the download"
  fi
  printf '%s\n' "$digest" | tr 'A-F' 'a-f'
}

# check_sha256 FILE NAME EXPECTED: EXPECTED is empty when no line names the file.
check_sha256() {
  actual=$(sha256_of "$1")
  if [ -z "$3" ] || [ "$3" != "$actual" ]; then
    if [ -z "$3" ]; then
      expected="(no line for $2)"
    else
      expected=$3
    fi
    rm -f "$1"
    printf 'rlmh install: checksum mismatch for %s\n  expected  %s\n  actual    %s\n' "$2" "$expected" "$actual" >&2
    die "nothing was installed"
  fi
}

# rc_escape TEXT: escapes TEXT for the inside of a double-quoted sh string.
rc_escape() {
  printf '%s' "$1" | sed 's/[\\"$`]/\\&/g'
}

# fish_escape TEXT: escapes TEXT for the inside of a double-quoted fish string.
fish_escape() {
  printf '%s' "$1" | sed 's/[\\"$]/\\&/g'
}

# sh_quote TEXT: TEXT as one single-quoted sh word, safe to paste into a command line.
sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

main() {
  detect_platform
  asset="rlmh-$OS-$ARCH"

  default_home=
  if [ -n "${HOME:-}" ]; then
    default_home="$HOME/.rlm-harness"
  fi
  custom_home=
  if [ -n "${RLMH_HOME:-}" ]; then
    home=$RLMH_HOME
    case "$home" in
      /*) ;;
      *) home="$(pwd)/$home" ;;
    esac
    while [ "${home%/}" != "$home" ] && [ "$home" != / ]; do
      home=${home%/}
    done
    if [ "$home" != "$default_home" ]; then
      custom_home=1
    fi
  else
    [ -n "$default_home" ] || die "HOME is not set; set HOME or RLMH_HOME"
    home=$default_home
  fi
  bin="$home/bin"

  version=${RLMH_VERSION:-latest}
  if [ -n "${RLMH_DOWNLOAD_BASE:-}" ]; then
    base=${RLMH_DOWNLOAD_BASE%/}
  elif [ "$version" = latest ]; then
    base="$REPO_URL/releases/latest/download"
  else
    case "$version" in
      v*) ;;
      *) version="v$version" ;;
    esac
    base="$REPO_URL/releases/download/$version"
  fi

  if [ ! -d "$home" ]; then
    mkdir -p "$home"
    MADE_HOME=$home
  fi
  if [ ! -d "$bin" ]; then
    mkdir -p "$bin"
    MADE_BIN=$bin
  fi
  TMP_DIR="$bin/.install.$$"
  rm -rf "$TMP_DIR"
  mkdir "$TMP_DIR"

  # 1. rlmh: download and check it before anything in <home>/bin changes.
  download "$base/SHA256SUMS" "$TMP_DIR/SHA256SUMS"
  download "$base/$asset" "$TMP_DIR/$asset"
  expected=$(tr -d '\r' <"$TMP_DIR/SHA256SUMS" | awk -v n="$asset" '{ f = $2; sub(/^\*/, "", f); if (f == n) { print tolower($1); exit } }')
  check_sha256 "$TMP_DIR/$asset" "$asset" "$expected"

  # 2. uv, only when it is not on PATH and not in <home>/bin already.
  uv_new=
  if command -v uv >/dev/null 2>&1; then
    uv_line="$(command -v uv) (already on PATH)"
  elif [ -e "$bin/uv" ]; then
    uv_line="$bin/uv (already installed)"
  else
    uv_archive="uv-$UV_TRIPLE.tar.gz"
    download "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$uv_archive" "$TMP_DIR/$uv_archive"
    check_sha256 "$TMP_DIR/$uv_archive" "$uv_archive" "$(uv_sha256 "$uv_archive")"
    mkdir "$TMP_DIR/uv"
    tar -xzf "$TMP_DIR/$uv_archive" -C "$TMP_DIR/uv" </dev/null
    uv_new=$(find "$TMP_DIR/uv" -type f -name uv | head -n 1)
    [ -n "$uv_new" ] || die "$uv_archive holds no file named uv"
    uv_line="$bin/uv (installed by this script)"
  fi

  # 3. Install. mv within one folder replaces the old file in one step, even while it runs.
  chmod +x "$TMP_DIR/$asset"
  mv -f "$TMP_DIR/$asset" "$bin/rlmh"
  if [ "$OS" = darwin ]; then
    xattr -d com.apple.quarantine "$bin/rlmh" 2>/dev/null || true
  fi
  if [ -n "$uv_new" ]; then
    cp "$uv_new" "$TMP_DIR/uv.new"
    chmod +x "$TMP_DIR/uv.new"
    mv -f "$TMP_DIR/uv.new" "$bin/uv"
  fi

  # 4. PATH: one marker line and one export line, in the rc file $SHELL reads.
  if [ -z "$custom_home" ]; then
    rc_bin="\$HOME/.rlm-harness/bin"
  else
    rc_bin=$(rc_escape "$bin")
  fi
  fish=
  case "${SHELL:-}" in
    */zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    */bash)
      if [ "$OS" = darwin ]; then
        rc="$HOME/.bash_profile"
      else
        rc="$HOME/.bashrc"
      fi
      ;;
    */fish)
      fish=1
      rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/rlmh.fish"
      ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [ -n "$fish" ]; then
    if [ -z "$custom_home" ]; then
      fish_bin="\$HOME/.rlm-harness/bin"
    else
      fish_bin=$(fish_escape "$bin")
    fi
    path_now="fish_add_path \"$fish_bin\""
    uninstall_rc="rm -f -- $(sh_quote "$rc")"
  else
    path_now="export PATH=\"$(rc_escape "$bin"):\$PATH\""
    uninstall_rc="delete the \"# rlm-harness\" lines from $rc"
  fi
  has_marker=
  if [ -f "$rc" ]; then
    if [ -n "$fish" ] || grep -q '^# rlm-harness$' "$rc"; then
      has_marker=1
    fi
  fi
  if [ "${RLMH_NO_MODIFY_PATH:-}" = 1 ]; then
    path_line="not changed (RLMH_NO_MODIFY_PATH=1); to use rlmh, run: $path_now"
    if [ -z "$has_marker" ]; then
      uninstall_rc=
    fi
  else
    case ":${PATH:-}:" in
      *":$bin:"* | *":$bin/:"*)
        path_line="$bin is already on PATH"
        if [ -z "$has_marker" ]; then
          uninstall_rc=
        fi
        ;;
      *)
        if [ -n "$has_marker" ]; then
          path_line="already set in $rc; open a new terminal, or run: $path_now"
        else
          mkdir -p "$(dirname "$rc")"
          if [ -n "$fish" ]; then
            printf '# rlm-harness\nfish_add_path "%s"\n' "$fish_bin" >"$rc"
          else
            if [ -s "$rc" ] && [ -n "$(tail -c 1 "$rc")" ]; then
              printf '\n' >>"$rc"
            fi
            printf '# rlm-harness\nexport PATH="%s:%s"\n' "$rc_bin" "\$PATH" >>"$rc"
          fi
          path_line="added to $rc; open a new terminal, or run: $path_now"
        fi
        ;;
    esac
  fi

  # 5. The last check: the installed binary runs and names its version.
  version_out=$("$bin/rlmh" --version </dev/null) || die "$bin/rlmh --version failed"
  case "$version_out" in
    "rlmh "*) installed=${version_out#rlmh } ;;
    *) die "$bin/rlmh --version printed \"$version_out\", not \"rlmh <version>\"" ;;
  esac
  DONE=1

  say "rlmh $installed installed"
  say "  binary   $bin/rlmh"
  say "  uv       $uv_line"
  say "  data     $home   (Python and the engine are added on first run)"
  say "  PATH     $path_line"
  if [ -n "$custom_home" ]; then
    say "Set RLMH_HOME=$home in your profile, or rlmh will look in ~/.rlm-harness."
  fi
  say 'Next: run "rlmh". It asks before it downloads Python 3.12.'
  if [ -n "$uninstall_rc" ]; then
    say "Uninstall: rm -rf -- $(sh_quote "$home"), and $uninstall_rc. Saved keys: delete them in /providers first."
  else
    say "Uninstall: rm -rf -- $(sh_quote "$home"). Saved keys: delete them in /providers first."
  fi
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# Everything runs from main, so a truncated download of this script runs nothing.
main
