"""KV cache: lays out sub-call bytes so the parts many calls share come first and stay byte-identical (D-119).

Cache-shaped sub-calls. The worker installs them only when its `init` sets `cache_api`, which the `default` profile
does and `training-v4` never does, so the LoRA's REPL stays training's own. `segments()` cuts `context` into fixed
slices at line ends. `llm(prompt, over=seg)` and `llm_batch(prompts, shared=..., over=...)` send a segment, or a
batch's shared preamble, as a separate prefix; the engine puts it first in the sub-call and marks it for the
provider's prompt cache, so asking about the same segment again is billed at the cache price.

Worker-side: imports only the standard library, never `rlm_engine`.
"""

from __future__ import annotations

SEPARATOR = "\n\n"  # between the prefix and the prompt; the engine joins them (bridge.py)
MIN_SEGMENT_CHARS = 1_000


class Segment(str):
    """A slice of `context`: the text itself, plus `id`, `start` and `end` (character offsets into `context`)."""

    def __new__(cls, text: str, id: int, start: int, end: int):
        obj = super().__new__(cls, text)
        obj.id, obj.start, obj.end = id, start, end
        return obj

    def __repr__(self) -> str:
        return f"Segment(id={self.id}, start={self.start}, end={self.end}, chars={len(self)})"


def cut(context: str, size: int) -> list[Segment]:
    """Fixed slices of about `size` characters, each ending at a line end when there is one; the same input and size
    always give the same slices."""
    out, start, n = [], 0, len(context)
    while start < n:
        end = min(start + size, n)
        if end < n:
            line_end = context.rfind("\n", start, end)
            if line_end > start:
                end = line_end + 1
        out.append(Segment(context[start:end], len(out), start, end))
        start = end
    return out


def namespace(context: str, segment_chars, bridge, limits: dict) -> dict:
    """The cell globals that replace `llm` and `llm_batch` and add `segments`. `bridge(op, prompts, prefixes)` sends
    one request to the engine; `limits` is the worker's live sub-call limits (`max_chars`, `oversize`)."""
    # The engine's size (manager.segment_chars) always fits a sub-call, even under a small subcall_max_chars, so it is
    # used as given; only a missing or broken value falls back. A size of your own can go as low as the default.
    usable = isinstance(segment_chars, int) and not isinstance(segment_chars, bool) and segment_chars > 0
    default_size = segment_chars if usable else 40_000
    least = min(MIN_SEGMENT_CHARS, default_size)
    cache: dict[int, list[Segment]] = {}

    def segments(size: int | None = None) -> list[Segment]:
        """Split `context` into fixed slices (about 40,000 characters by default), cut at line ends. Pass them to
        llm(..., over=) or llm_batch(..., over=): the harness sends a segment's text before your prompt, byte for byte,
        so asking about the same segment again costs the cache price."""
        size = default_size if size is None else size
        if not isinstance(size, int) or isinstance(size, bool) or size < least:
            raise ValueError(f"segments(size) takes a whole number of characters, at least {least:,}")
        if size not in cache:
            cache[size] = cut(context, size)
        return list(cache[size])

    def _check(prompt: str, prefix: str | None) -> None:
        total = len(prompt) + (len(prefix) + len(SEPARATOR) if prefix is not None else 0)
        if total > limits["max_chars"] and limits["oversize"] == "error":
            raise ValueError(f"sub-call is {total:,} characters with its segment or shared text; one sub-call reads at "
                             f"most {limits['max_chars']:,}. Use smaller segments or a shorter prompt.")

    def _prefix(item) -> str | None:
        if item is None:
            return None
        if not isinstance(item, str):
            raise TypeError(f"over takes a segment (a str), not {type(item).__name__}")
        return str(item) or None  # an empty segment is no prefix at all

    def llm(prompt: str, over=None) -> str:
        """Ask a language model one question. With over=segment, the segment's text is sent first, cached."""
        prompt, prefix = str(prompt), _prefix(over)
        _check(prompt, prefix)
        return bridge("llm", [prompt], [prefix])[0]

    def llm_batch(prompts: list[str], shared: str | None = None, over=None) -> list[str]:
        """Ask several prompts in parallel; each prompt counts as one sub-call. shared= is text sent first in every
        prompt (instructions, labels, examples); over= is one segment for all prompts or one per prompt, sent first
        and cached. Outputs come back in input order."""
        if isinstance(prompts, (str, bytes)):
            raise TypeError("llm_batch expects a list of prompts, not a single string")
        prompts = [str(p) for p in prompts]
        if shared is not None and not isinstance(shared, str):
            raise TypeError(f"shared takes a str, not {type(shared).__name__}")
        shared = shared or None  # empty shared text is no prefix at all
        if over is None or isinstance(over, str):
            overs = [over] * len(prompts)
        else:
            overs = list(over)
            if len(overs) != len(prompts):
                raise ValueError(f"over has {len(overs)} segments for {len(prompts)} prompts; give one, or one per prompt")
        bodies, prefixes = [], []
        for prompt, item in zip(prompts, overs):
            segment = _prefix(item)
            if segment is not None:  # the segment is the cached prefix; the shared text goes with the prompt
                body, prefix = (shared + SEPARATOR + prompt) if shared else prompt, segment
            else:
                body, prefix = prompt, shared
            _check(body, prefix)
            bodies.append(body)
            prefixes.append(prefix)
        return bridge("llm_batch", bodies, prefixes)

    return {"segments": segments, "llm": llm, "llm_batch": llm_batch}
