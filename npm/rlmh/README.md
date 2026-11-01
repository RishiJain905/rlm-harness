# rlmh

A model-agnostic harness for Recursive Language Models. The model never reads a long input directly. It writes Python against the input in a REPL, hands pieces of it to sub-calls, and submits an answer. Source, design and docs: [RishiJain905/rlm-harness](https://github.com/RishiJain905/rlm-harness).

This package installs the compiled `rlmh` binary for your platform: macOS arm64 or x64, Windows x64, or Linux x64 (glibc).

## Install

```
npm i -g rlm-harness
```

```
bun add -g --trust rlm-harness
```

- **Bun needs `--trust`.** Bun skips install scripts unless told otherwise, and on Windows `rlmh` cannot start without its install step. If you already installed without it, run `bun pm -g trust rlm-harness`.
- **Without Node or Bun**, use the one-line installers on the [releases page](https://github.com/RishiJain905/rlm-harness/releases/latest).

## What the install does

The install step links the binary from `@rlmh/<platform>-<arch>` into this package, so the `rlmh` command is the compiled binary itself. No Node or Bun process sits in between, so `rlmh` never loads a `.env` or a `bunfig.toml` from the folder you run it in.

On first run, `rlmh` asks before it downloads Python 3.12, through the bundled uv, into `~/.rlm-harness/python/` (or `$RLMH_HOME`). Nothing else on the machine changes.

## Uninstall

```
npm rm -g rlm-harness
```

or

```
bun rm -g rlm-harness
```

This leaves `~/.rlm-harness/` in place, holding Python, the engine, settings and run logs. To remove everything:

1. Delete saved keys in `/providers` first. They live in the OS credential store, not in that folder.
2. Delete the folder.

## Notes

- Install from a folder you trust. `npm` and `bun` read the current folder's `.npmrc` or `bunfig.toml`, which can point them at another registry.
- On Windows, close `rlmh` before upgrading. A running `rlmh.exe` cannot be replaced.
- The binaries are not code signed. macOS ones carry an ad hoc signature only.
