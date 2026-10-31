# Attribution for `models.json`

`models.json` in this folder is a subset of the model catalog of
[oh-my-pi](https://github.com/can1357/oh-my-pi) (OMP), which is MIT licensed. It is built from
`packages/catalog/src/models.json` in that repository, at the commit named in the `source.commit`
field of `models.json`, by `scripts/build-catalog.ts`. OMP's licence text is below.

## What we changed

- **Providers.** We kept five of OMP's providers: `anthropic`, `openai`, `deepseek`, `openrouter`
  and `google`, which we call `gemini`. For OpenRouter we kept only ids from anthropic, openai,
  google, deepseek, qwen, meta-llama, mistralai, x-ai, moonshotai and z-ai, in id order, at most 300.
- **Models.** We kept chat models only. Entries with a `kind` (image, stt, embedding, judge, rerank,
  video), entries without text input, entries with no context window or no cost, and entries with a
  negative price (variable-priced routers) are dropped. For OpenAI we also dropped ids that work
  only on the Responses API (ids ending `-pro`, and ids containing `codex`, `deep-research`,
  `realtime` or `computer-use`) and OMP's virtual aliases (an entry whose `requestModelId` names
  another id), because `rlmh` calls Chat Completions.
- **OpenRouter batch variants.** OpenRouter ids ending `:batch` (its batch-API variants of a model)
  are dropped before the vendor list and the 300 cap.
- **Gemini models the chat endpoint can't serve.** `rlmh` calls Gemini through its OpenAI-compatible
  endpoint, so we dropped `gemini` ids containing `deep-research`, `computer-use` or `robotics`, and
  the Live API ones (a `live` segment, as in `gemini-live-2.5-flash` and `gemini-3.1-flash-live-preview`).
- **Fields.** We kept the name, context window, maximum output tokens, the four prices (USD per 1M
  tokens: input, output, cache read, cache write), whether the model takes tools, and whether it
  reasons. We renamed them to `context_window`, `max_output`, `price`, `tool_call` and `reasoning`,
  dropped every other field, ignored OMP's long-context and time-based price tiers, and rounded
  prices to 9 decimal places.
- **`cache_min_tokens`** is not OMP data. It was added by hand from Anthropic's prompt-caching page
  and OpenAI's documentation of the shortest prompt each caches (Anthropic per model family, OpenAI
  1024 for every model); Gemini, DeepSeek and OpenRouter entries have none (`null`).
- **Format.** OMP stores the file in a compact, interned format. `scripts/build-catalog.ts` decodes
  it with a decoder of our own, written from OMP's `packages/catalog/src/model-catalog-format.ts`,
  then sorts the models by provider and id.

## Third-party sources

OMP builds its data from third-party sources (stencil.so, provider model discovery and OpenCode
docs). Check their terms before the first release of `rlmh`. The licence below covers OMP's own
files, not what those sources allow.

## Licence of `packages/catalog` in oh-my-pi

```
MIT License

Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Licence of the oh-my-pi repository root

```
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
