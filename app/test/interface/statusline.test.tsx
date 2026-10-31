// KV cache: none; the interface never touches the bytes sent to the model.
// The status line and the pure helpers behind it. `describe("format.ts")` needs no Ink: formats,
// glyphs, windows, layout and text cleaning. The screen tests (statusModel, the StatusLine
// component) are appended below the marker.

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import type { Catalog } from "../../src/gateway/catalog.ts";
import { ApprovalQueue } from "../../src/interface/approvals.ts";
import { emptyView, statusModel, type AppDeps, type RunView } from "../../src/interface/store.ts";
import { defaultSettings, setSetting } from "../../src/settings.ts";
import { createFakeApp, type FakeApp } from "../fakes/engine.ts";
import { KEYS, mount, type Mounted } from "./helpers.ts";
import {
  cacheTone,
  contextTone,
  formatClock,
  formatCost,
  formatDuration,
  formatTokens,
  glyphs,
  layoutHeights,
  layoutStatus,
  sanitize,
  truncate,
  unicodeSupported,
  windowLines,
  wrapText,
  type StatusSegment,
} from "../../src/interface/format.ts";

setDefaultTimeout(20_000);

const width = (s: string): number => Bun.stringWidth(s);

describe("format.ts", () => {
  describe("formatTokens", () => {
    const table: Array<[number, string]> = [
      [0, "0"],
      [7, "7"],
      [999, "999"],
      [999.4, "999"],
      [999.6, "1k"],
      [1000, "1k"],
      [1234, "1.2k"],
      [12_300, "12.3k"],
      [64_000, "64k"],
      [99_940, "99.9k"],
      [99_960, "100k"],
      [123_456, "123k"],
      [200_000, "200k"],
      [999_499, "999k"],
      [999_999, "1M"],
      [1_000_000, "1M"],
      [1_234_567, "1.2M"],
      [12_000_000, "12M"],
      [123_000_000, "123M"],
    ];
    test.each(table)("%d -> %s", (n, want) => {
      expect(formatTokens(n)).toBe(want);
    });

    test("never prints a trailing .0 or a thousand of anything", () => {
      for (let n = 0; n <= 2_000_000; n += 997) {
        const s = formatTokens(n);
        expect(s).not.toContain(".0");
        expect(s).not.toMatch(/^1000k$/);
        expect(s).toMatch(/^\d+(\.\d)?[kM]?$/);
      }
    });

    test("not a number and negative values print 0", () => {
      expect(formatTokens(Number.NaN)).toBe("0");
      expect(formatTokens(-5)).toBe("0");
    });
  });

  describe("formatCost", () => {
    const table: Array<[number, string]> = [
      [0, "$0.0000"],
      [0.0123, "$0.0123"],
      [0.00004, "$0.0000"],
      [0.5, "$0.5000"],
      [0.99994, "$0.9999"],
      [0.99996, "$1.00"],
      [1, "$1.00"],
      [1.234, "$1.23"],
      [12.5, "$12.50"],
      [1234.567, "$1234.57"],
    ];
    test.each(table)("%d -> %s", (usd, want) => {
      expect(formatCost(usd)).toBe(want);
    });

    test("not a number and negative values print $0.0000", () => {
      expect(formatCost(Number.NaN)).toBe("$0.0000");
      expect(formatCost(-1)).toBe("$0.0000");
    });
  });

  describe("formatDuration", () => {
    const table: Array<[number, string]> = [
      [0, "0.0s"],
      [3.2, "3.2s"],
      [3.24, "3.2s"],
      [59.9, "59.9s"],
      [59.97, "1m00s"],
      [60, "1m00s"],
      [65, "1m05s"],
      [65.9, "1m05s"],
      [600, "10m00s"],
      [3599, "59m59s"],
      [3599.9, "59m59s"],
      [3600, "1h00m"],
      [3720, "1h02m"],
      [36_000, "10h00m"],
    ];
    test.each(table)("%d -> %s", (seconds, want) => {
      expect(formatDuration(seconds)).toBe(want);
    });
  });

  describe("formatClock", () => {
    const table: Array<[number, string]> = [
      [0, "0:00"],
      [0.9, "0:00"],
      [12, "0:12"],
      [12.9, "0:12"],
      [59, "0:59"],
      [60, "1:00"],
      [725, "12:05"],
      [3599, "59:59"],
      [3600, "1:00:00"],
      [3723, "1:02:03"],
      [-4, "0:00"],
    ];
    test.each(table)("%d -> %s", (seconds, want) => {
      expect(formatClock(seconds)).toBe(want);
    });
  });

  describe("layoutStatus", () => {
    const segments: StatusSegment[] = [
      { id: "state", text: "running 0:12" },
      { id: "root", text: "root deepseek/deepseek-chat" },
      { id: "sub", text: "sub same" },
      { id: "ctx", text: "ctx 12.3k/64k 19%" },
      { id: "cost", text: "$0.0123 (root $0.0100 + sub $0.0023)" },
      { id: "cache", text: "cache 87%" },
      { id: "budget", text: "turns left 14/20, sub-calls left 61/80" },
      { id: "mode", text: "accept-edits" },
    ];
    const joined = (kept: StatusSegment[]): string => kept.map((s) => s.text).join(" | ");
    const ids = (kept: StatusSegment[]): string[] => kept.map((s) => s.id);

    test("everything fits in a wide terminal, in the original order", () => {
      const kept = layoutStatus(segments, 200);
      expect(ids(kept)).toEqual(["state", "root", "sub", "ctx", "cost", "cache", "budget", "mode"]);
      expect(kept).toEqual(segments);
      expect(width(joined(kept))).toBeLessThanOrEqual(200);
    });

    test("120 columns: mode, sub, cache and root are dropped", () => {
      const kept = layoutStatus(segments, 120);
      expect(ids(kept)).toEqual(["state", "ctx", "cost", "budget"]);
      expect(width(joined(kept))).toBeLessThanOrEqual(120);
    });

    test("80 columns: cost goes too", () => {
      const kept = layoutStatus(segments, 80);
      expect(ids(kept)).toEqual(["state", "ctx", "budget"]);
      expect(width(joined(kept))).toBeLessThanOrEqual(80);
    });

    test("60 columns: context goes too, and the state and the budget remain", () => {
      const kept = layoutStatus(segments, 60);
      expect(ids(kept)).toEqual(["state", "budget"]);
      expect(width(joined(kept))).toBeLessThanOrEqual(60);
    });

    test("10 columns keeps only the state, even though it does not fit", () => {
      const kept = layoutStatus(segments, 10);
      expect(ids(kept)).toEqual(["state"]);
      expect(kept[0]?.text).toBe("running 0:12");
    });

    test("the state is kept at every width, the joined text fits whenever it can, and a wider terminal never shows less", () => {
      const stateOnly = width("running 0:12");
      let shown = 0;
      for (let columns = 0; columns <= 200; columns++) {
        const kept = layoutStatus(segments, columns);
        expect(ids(kept)).toContain("state");
        if (columns >= stateOnly) expect(width(joined(kept))).toBeLessThanOrEqual(columns);
        expect(kept).toEqual(segments.filter((s) => kept.includes(s))); // the original order
        expect(kept.length).toBeGreaterThanOrEqual(shown);
        shown = kept.length;
      }
      expect(shown).toBe(segments.length);
    });

    test("segments that are absent are skipped in the drop order", () => {
      const some = segments.filter((s) => s.id === "state" || s.id === "cost" || s.id === "mode");
      expect(ids(layoutStatus(some, 200))).toEqual(["state", "cost", "mode"]);
      expect(ids(layoutStatus(some, 60))).toEqual(["state", "cost"]);
      expect(ids(layoutStatus(some, 30))).toEqual(["state"]);
    });

    test("it does not change its input", () => {
      const copy = segments.map((s) => ({ ...s }));
      layoutStatus(segments, 30);
      expect(segments).toEqual(copy);
    });
  });

  describe("tones", () => {
    test("contextTone: ok under 60, warn under 85, else high", () => {
      expect(contextTone(0)).toBe("ok");
      expect(contextTone(59.9)).toBe("ok");
      expect(contextTone(60)).toBe("warn");
      expect(contextTone(84.9)).toBe("warn");
      expect(contextTone(85)).toBe("high");
      expect(contextTone(100)).toBe("high");
      expect(contextTone(130)).toBe("high");
    });

    test("cacheTone: ok from 0.6, warn from 0.2, else high", () => {
      expect(cacheTone(1)).toBe("ok");
      expect(cacheTone(0.6)).toBe("ok");
      expect(cacheTone(0.599)).toBe("warn");
      expect(cacheTone(0.2)).toBe("warn");
      expect(cacheTone(0.199)).toBe("high");
      expect(cacheTone(0)).toBe("high");
    });
  });

  describe("windowLines", () => {
    test("a list that fits is shown whole", () => {
      expect(windowLines(5, 3, 5)).toEqual({ start: 0, end: 5, above: 0, below: 0 });
      expect(windowLines(3, 0, 10)).toEqual({ start: 0, end: 3, above: 0, below: 0 });
      expect(windowLines(0, 0, 10)).toEqual({ start: 0, end: 0, above: 0, below: 0 });
    });

    test("the selection sits near the middle, with a marker line on each side", () => {
      // 7 lines: 5 items and two markers
      expect(windowLines(30, 15, 7)).toEqual({ start: 13, end: 18, above: 13, below: 12 });
    });

    test("at the top and the bottom the unused marker line goes to an item", () => {
      expect(windowLines(30, 0, 7)).toEqual({ start: 0, end: 6, above: 0, below: 24 });
      expect(windowLines(30, 2, 7)).toEqual({ start: 0, end: 6, above: 0, below: 24 });
      expect(windowLines(30, 29, 7)).toEqual({ start: 24, end: 30, above: 24, below: 0 });
      expect(windowLines(30, 27, 7)).toEqual({ start: 24, end: 30, above: 24, below: 0 });
    });

    test("at height 1 or 2 only items show and no marker is asked for", () => {
      expect(windowLines(30, 10, 1)).toEqual({ start: 10, end: 11, above: 0, below: 0 });
      expect(windowLines(30, 10, 2)).toEqual({ start: 9, end: 11, above: 0, below: 0 });
      expect(windowLines(30, 0, 2)).toEqual({ start: 0, end: 2, above: 0, below: 0 });
      expect(windowLines(30, 29, 2)).toEqual({ start: 28, end: 30, above: 0, below: 0 });
    });

    test("height under 1 shows nothing", () => {
      expect(windowLines(30, 10, 0)).toEqual({ start: 0, end: 0, above: 0, below: 0 });
      expect(windowLines(30, 10, -3)).toEqual({ start: 0, end: 0, above: 0, below: 0 });
    });

    test("a selection outside the list is clamped into it", () => {
      expect(windowLines(30, 99, 7)).toEqual(windowLines(30, 29, 7));
      expect(windowLines(30, -4, 7)).toEqual(windowLines(30, 0, 7));
    });

    test("invariants over a grid of counts, selections and heights", () => {
      for (let count = 0; count <= 40; count++) {
        for (let height = -1; height <= 14; height++) {
          let lastStart = 0;
          for (let selected = -2; selected <= count + 1; selected++) {
            const w = windowLines(count, selected, height);
            const where = `count=${count} selected=${selected} height=${height} -> ${JSON.stringify(w)}`;
            const markers = (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0);
            expect(w.start >= 0 && w.start <= w.end && w.end <= count, where).toBe(true);
            if (count === 0 || height < 1) {
              expect(w, where).toEqual({ start: 0, end: 0, above: 0, below: 0 });
              continue;
            }
            const sel = Math.min(count - 1, Math.max(0, selected));
            expect(w.start <= sel && sel < w.end, where).toBe(true); // the selection is always visible
            expect(w.end - w.start + markers, where).toBeLessThanOrEqual(height); // the line budget
            if (count <= height) {
              expect(w, where).toEqual({ start: 0, end: count, above: 0, below: 0 });
            } else if (height >= 3) {
              expect(w.end - w.start + markers, where).toBe(height); // the budget is used in full
              expect(w.above, where).toBe(w.start);
              expect(w.below, where).toBe(count - w.end);
              expect(w.start, where).toBeGreaterThanOrEqual(lastStart - 1); // no big jumps as the selection moves
            } else {
              expect(w.end - w.start, where).toBe(height);
              expect(w.above + w.below, where).toBe(0);
            }
            lastStart = w.start;
          }
        }
      }
    });

    test("moving down one row at a time scrolls without skipping an item", () => {
      let seen = -1;
      for (let selected = 0; selected < 30; selected++) {
        const w = windowLines(30, selected, 7);
        expect(w.start).toBeLessThanOrEqual(seen + 1);
        seen = Math.max(seen, w.end - 1);
      }
      expect(seen).toBe(29);
    });
  });

  describe("layoutHeights", () => {
    test("a plain screen: the transcript takes everything but the prompt box and the status line", () => {
      expect(layoutHeights(24, { panel: false, approval: 0, menu: 0 })).toEqual({
        transcript: 19,
        panel: 0,
        approval: 0,
        menu: 0,
        prompt: 3,
        status: 1,
      });
    });

    test("the panel gets half of the free rows", () => {
      expect(layoutHeights(24, { panel: true, approval: 0, menu: 0 })).toEqual({
        transcript: 10,
        panel: 9,
        approval: 0,
        menu: 0,
        prompt: 3,
        status: 1,
      });
    });

    test("an approval and a menu take what they ask for", () => {
      const h = layoutHeights(30, { panel: true, approval: 6, menu: 5 });
      expect(h.approval).toBe(6);
      expect(h.menu).toBe(5);
      expect(h.transcript + h.panel).toBe(30 - 1 - 3 - 1 - 6 - 5);
    });

    test("the panel stays out when fewer than 7 rows are free", () => {
      expect(layoutHeights(12, { panel: true, approval: 0, menu: 0 }).panel).toBe(4);
      expect(layoutHeights(12, { panel: true, approval: 1, menu: 0 }).panel).toBe(0);
      expect(layoutHeights(12, { panel: true, approval: 0, menu: 1 }).panel).toBe(0);
    });

    test("the six heights add up to rows - 1 for rows 12 to 60, and the minimums hold", () => {
      for (let rows = 12; rows <= 60; rows++) {
        for (const panel of [false, true]) {
          for (const approval of [0, 1, 3, 6, 40]) {
            for (const menu of [0, 2, 5, 40]) {
              const h = layoutHeights(rows, { panel, approval, menu });
              const where = `rows=${rows} panel=${panel} approval=${approval} menu=${menu} -> ${JSON.stringify(h)}`;
              expect(h.transcript + h.panel + h.approval + h.menu + h.prompt + h.status, where).toBe(rows - 1);
              expect(h.prompt, where).toBe(3);
              expect(h.status, where).toBe(1);
              expect(h.transcript, where).toBeGreaterThanOrEqual(3);
              expect(h.approval, where).toBeLessThanOrEqual(approval);
              expect(h.menu, where).toBeLessThanOrEqual(menu);
              if (!panel) expect(h.panel, where).toBe(0);
              if (h.panel > 0) expect(h.panel, where).toBeGreaterThanOrEqual(4);
              expect(Object.values(h).every((v) => Number.isInteger(v) && v >= 0), where).toBe(true);
            }
          }
        }
      }
    });

    test("a tiny terminal gives no negative height", () => {
      for (let rows = -2; rows < 12; rows++) {
        const h = layoutHeights(rows, { panel: true, approval: 9, menu: 9 });
        expect(Object.values(h).every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
      }
    });
  });

  describe("sanitize", () => {
    test("strips colour codes, OSC titles, bells and carriage returns", () => {
      expect(sanitize("\x1b[31mred\x1b[0m")).toBe("red");
      expect(sanitize("a\x1b]0;title\x07b")).toBe("ab");
      expect(sanitize("a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\b")).toBe("alinkb");
      expect(sanitize("ding\x07")).toBe("ding");
      expect(sanitize("a\rb")).toBe("a\nb");
      expect(sanitize("a\r\nb\r\n")).toBe("a\nb\n");
      expect(sanitize("a\r\rb")).toBe("a\n\nb");
    });

    test("strips cursor movement, other C0 controls, DEL and C1 controls", () => {
      expect(sanitize("a\x1b[2J\x1b[Hb\x1b[?25l")).toBe("ab");
      expect(sanitize("a\x00b\x08c\x0bd\x0ce\x1bf\x7fg\x85h\x9bi")).toBe("abcdefghi");
    });

    test("keeps newlines, tabs and ordinary text, including non-ASCII", () => {
      const text = "line one\n\tline two\n日本語 é 😀";
      expect(sanitize(text)).toBe(text);
    });

    test("an unterminated escape string is not allowed to swallow the rest", () => {
      expect(sanitize("a\x1b]0;no end\nrest")).toBe("a]0;no end\nrest");
    });
  });

  describe("wrapText", () => {
    const widest = (lines: string[]): number => Math.max(0, ...lines.map(width));

    test("wraps at spaces", () => {
      expect(wrapText("hello world foo bar", 8)).toEqual(["hello", "world", "foo bar"]);
      expect(wrapText("short", 20)).toEqual(["short"]);
    });

    test("an empty line stays one empty string", () => {
      expect(wrapText("", 10)).toEqual([""]);
      expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
    });

    test("a word wider than the width is broken, and nothing is lost", () => {
      const lines = wrapText("x ".concat("a".repeat(25), " y"), 10);
      expect(lines).toEqual(["x", "aaaaaaaaaa", "aaaaaaaaaa", "aaaaa y"]);
      expect(widest(lines)).toBeLessThanOrEqual(10);
    });

    test("wide characters count 2", () => {
      const lines = wrapText("日本語のテキスト", 5);
      expect(lines).toEqual(["日本", "語の", "テキ", "スト"]);
      for (const l of lines) expect(width(l)).toBeLessThanOrEqual(5);
      const mixed = wrapText("abc 日本語 def 日本語日本語日本語", 7);
      for (const l of mixed) expect(width(l)).toBeLessThanOrEqual(7);
    });

    test("never splits a surrogate pair or a grapheme cluster", () => {
      const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      const lines = wrapText("😀".repeat(9), 5);
      for (const l of lines) {
        expect(lone.test(l)).toBe(false);
        expect(width(l)).toBeLessThanOrEqual(5);
      }
      expect(lines.join("")).toBe("😀".repeat(9));
      const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
      expect(wrapText(`a${family}b`, 2).some((l) => l.includes(family))).toBe(true);
      expect(wrapText("é".repeat(6), 3).join("")).toBe("é".repeat(6));
    });

    test("tabs expand to the next multiple of 4 columns", () => {
      expect(wrapText("a\tb", 40)).toEqual(["a   b"]);
      expect(wrapText("abcd\te", 40)).toEqual(["abcd    e"]);
      expect(wrapText("\tx", 40)).toEqual(["    x"]);
    });

    test("sanitizes first", () => {
      expect(wrapText("\x1b[31mred\x1b[0m\r\nnext\x07", 20)).toEqual(["red", "next"]);
    });

    test("width under 1 is treated as 1", () => {
      expect(wrapText("abc", 0)).toEqual(["a", "b", "c"]);
      expect(wrapText("abc", -4)).toEqual(["a", "b", "c"]);
    });

    test("every line fits, whatever the text and the width, and no word is lost", () => {
      const samples = [
        "The quick brown fox jumps over the lazy dog, again and again and again.",
        "    indented code\n        more indented code that is long enough to wrap around",
        "https://example.com/a/very/long/path/with/no/spaces/at/all/that/goes/on/and/on",
        "混合 text with 日本語 and ascii, 日本語日本語日本語日本語日本語",
        "tab\tseparated\tvalues\there",
        "trailing spaces   \n\n   \nend",
      ];
      for (const text of samples) {
        for (let w = 2; w <= 40; w++) {
          const lines = wrapText(text, w);
          for (const l of lines) expect(width(l), `${JSON.stringify(text)} at ${w}: ${JSON.stringify(l)}`).toBeLessThanOrEqual(w);
          const squash = (s: string): string => s.replace(/\s+/g, "");
          expect(squash(lines.join("")), `${JSON.stringify(text)} at ${w}`).toBe(squash(sanitize(text)));
        }
      }
    });
  });

  describe("truncate", () => {
    test("short text is returned whole, as one line", () => {
      expect(truncate("hello", 10, "…")).toBe("hello");
      expect(truncate("hello", 5, "…")).toBe("hello");
      expect(truncate("a\nb\tc", 10, "…")).toBe("a b c");
    });

    test("long text is cut so that the cut and the marker fit", () => {
      expect(truncate("hello world", 8, "…")).toBe("hello w…");
      expect(truncate("hello world", 8, "...")).toBe("hello...");
      for (let w = 1; w <= 12; w++) expect(width(truncate("hello world, again", w, "..."))).toBeLessThanOrEqual(w);
    });

    test("wide characters are not split, and the marker still fits", () => {
      expect(truncate("日本語テキスト", 7, "…")).toBe("日本語…");
      for (let w = 1; w <= 14; w++) expect(width(truncate("日本語テキスト", w, "…"))).toBeLessThanOrEqual(w);
    });

    test("width 0 or less gives an empty string", () => {
      expect(truncate("hello", 0, "…")).toBe("");
      expect(truncate("hello", -2, "…")).toBe("");
    });

    test("a marker wider than the width is itself cut", () => {
      expect(truncate("hello world", 2, "...")).toBe("..");
    });

    test("sanitizes first", () => {
      expect(truncate("\x1b[31mred\x1b[0m\r\nnext", 20, "…")).toBe("red next");
    });
  });

  describe("glyphs", () => {
    test("unicode set", () => {
      const g = glyphs(true);
      expect(g.border).toBe("round");
      expect(g.spinner).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
      expect([g.full, g.empty, g.on, g.off, g.more]).toEqual(["█", "░", "●", "○", "…"]);
    });

    test("ascii set uses printable ASCII only, and none of the unicode glyphs", () => {
      const g = glyphs(false);
      expect(g.border).toBe("classic");
      expect(g.spinner).toEqual(["|", "/", "-", "\\"]);
      expect([g.full, g.empty, g.on, g.off, g.more]).toEqual(["#", ".", "*", ".", "..."]);
      const all = [...g.spinner, g.full, g.empty, g.on, g.off, g.more].join("");
      expect(all).toMatch(/^[\x20-\x7e]+$/);
      for (const ch of "●╭─█…⠋") expect(all).not.toContain(ch);
    });

    test("every spinner frame and bar cell is one column wide", () => {
      for (const unicode of [true, false]) {
        const g = glyphs(unicode);
        for (const cell of [...g.spinner, g.full, g.empty, g.on, g.off]) expect(width(cell)).toBe(1);
      }
    });
  });

  describe("unicodeSupported", () => {
    const table: Array<[string, Record<string, string | undefined>, string, boolean]> = [
      ["win32 in Windows Terminal", { WT_SESSION: "abc-123" }, "win32", true],
      ["win32 with an empty WT_SESSION", { WT_SESSION: "" }, "win32", false],
      ["win32 bare (a legacy console window)", {}, "win32", false],
      ["win32 in the VS Code terminal", { TERM_PROGRAM: "vscode" }, "win32", true],
      ["win32 in ConEmu", { ConEmuANSI: "ON" }, "win32", true],
      ["win32 with ConEmuANSI off", { ConEmuANSI: "OFF" }, "win32", false],
      ["win32 with TERM=xterm-256color", { TERM: "xterm-256color" }, "win32", true],
      ["win32 with TERM=alacritty", { TERM: "alacritty" }, "win32", true],
      ["win32 with TERM=xterm", { TERM: "xterm" }, "win32", false],
      ["win32 with TERM_PROGRAM=Apple_Terminal", { TERM_PROGRAM: "Apple_Terminal" }, "win32", false],
      ["linux default", {}, "linux", true],
      ["linux xterm", { TERM: "xterm-256color" }, "linux", true],
      ["the linux console", { TERM: "linux" }, "linux", false],
      ["darwin default", { TERM_PROGRAM: "Apple_Terminal" }, "darwin", true],
      ["RLMH_ASCII=1 on win32", { RLMH_ASCII: "1", WT_SESSION: "abc-123" }, "win32", false],
      ["RLMH_ASCII=1 on linux", { RLMH_ASCII: "1" }, "linux", false],
      ["RLMH_ASCII=1 on darwin", { RLMH_ASCII: "1" }, "darwin", false],
      ["RLMH_ASCII=0 changes nothing", { RLMH_ASCII: "0" }, "linux", true],
    ];
    test.each(table)("%s", (_name, env, platform, want) => {
      expect(unicodeSupported(env, platform)).toBe(want);
    });
  });
});

// ---- screen tests: statusModel, StatusLine and the frame sizes are appended below this line ----

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 0 };

function stubDeps(window: number | undefined, settings = setSetting(defaultSettings(), "root.model", "deepseek/deepseek-chat")): AppDeps {
  const catalog = { get: () => (window === undefined ? undefined : { context_window: window }) } as unknown as Catalog;
  return { session: { settings } as AppDeps["session"], catalog, approvals: new ApprovalQueue(), keys: {} as AppDeps["keys"], home: "/h", cwd: "/w" };
}

function runningView(over: Partial<RunView> = {}): RunView {
  const ref = { provider: "deepseek", model: "deepseek-chat", thinking: null };
  return {
    ...emptyView(),
    phase: "running",
    runId: "r_000000000001",
    root: ref,
    sub: ref,
    permissionMode: "accept-edits",
    limits: { max_turns: 20, max_subcalls: 80, root_max_tokens: 4096, output_max_chars: 8192, cell_timeout_s: 120, subcall_max_chars: 24000, subcall_max_tokens: 1024 },
    budget: { turnsLeft: 14, subcallsLeft: 61 },
    startedAt: 1_000_000,
    now: 1_012_000,
    ctx: { tokens: 12_300, estimated: false },
    totals: { root: { ...USAGE, cost_usd: 0.01 }, sub: { ...USAGE, cost_usd: 0.0023 }, cost_usd: 0.0123, cache_hit_rate: 0.87 },
    ...over,
  };
}

const text = (segs: { id: string; text: string }[], id: string) => segs.find((s) => s.id === id)?.text;

describe("statusModel", () => {
  test("(1) a running view: cost, cache, budget and context", () => {
    const segs = statusModel(runningView(), stubDeps(64_000));
    expect(text(segs, "state")).toBe("running 0:12");
    expect(text(segs, "root")).toBe("root deepseek/deepseek-chat");
    expect(text(segs, "sub")).toBe("sub same");
    expect(text(segs, "ctx")).toBe("ctx 12.3k/64k 19%");
    expect(text(segs, "cost")).toBe("$0.0123 (root $0.0100 + sub $0.0023)");
    expect(text(segs, "cache")).toBe("cache 87%");
    expect(text(segs, "budget")).toBe("turns left 14/20, sub-calls left 61/80");
    expect(text(segs, "mode")).toBe("accept-edits");
    expect(segs.find((s) => s.id === "ctx")!.tone).toBe("ok");
    expect(segs.find((s) => s.id === "cache")!.tone).toBe("ok");
  });

  test("(2) an unknown window is ?, a null hit rate is --, and with no run the models come from settings", () => {
    const view = runningView({ ctx: { tokens: 900, estimated: true } });
    view.totals = { ...view.totals!, cache_hit_rate: null };
    const segs = statusModel(view, stubDeps(undefined));
    expect(text(segs, "ctx")).toBe("ctx ~900/?");
    expect(text(segs, "cache")).toBe("cache --");
    const settings = setSetting(setSetting(defaultSettings(), "root.model", "anthropic/claude-sonnet-5"), "sub.model", "openai/gpt-5-mini");
    const idle = statusModel(emptyView(), stubDeps(64_000, settings), "default");
    expect(idle.map((s) => s.id)).toEqual(["state", "root", "sub", "mode"]);
    expect(text(idle, "state")).toBe("idle");
    expect(text(idle, "root")).toBe("root anthropic/claude-sonnet-5");
    expect(text(idle, "sub")).toBe("sub openai/gpt-5-mini");
    expect(text(idle, "mode")).toBe("default");
    expect(text(statusModel(emptyView(), stubDeps(64_000, defaultSettings())), "root")).toBe("root none");
  });

  test("states: waiting for approval, cancelling, finished, cancelled, failed", () => {
    const deps = stubDeps(64_000);
    void deps.approvals.ask({ run_id: "r", kind: "shell", detail: "ls", turn: 1, inside_workspace: true });
    expect(text(statusModel(runningView(), deps), "state")).toBe("waiting for approval");
    deps.approvals.denyAll();
    expect(text(statusModel(runningView({ phase: "cancelling" }), deps), "state")).toBe("cancelling");
    expect(text(statusModel(runningView({ phase: "finished" }), deps), "state")).toBe("finished");
    expect(text(statusModel(runningView({ phase: "cancelled" }), deps), "state")).toBe("cancelled");
    expect(text(statusModel(runningView({ phase: "failed", failKind: "auth" }), deps), "state")).toBe("failed: auth");
  });
});

describe("StatusLine on screen", () => {
  let app: FakeApp | undefined;
  let m: Mounted | undefined;
  afterEach(async () => {
    m?.unmount();
    await app?.dispose();
    app = m = undefined;
  });

  test("(6) with the real gateway, ctx after the first reply is that reply's input + output tokens", async () => {
    app = await createFakeApp({ scenario: "approvalShell", settings: { "permissions.mode": "default" } });
    const replies: { turn: number; usage: typeof USAGE }[] = [];
    app.bus.on("engine.event", (e) => {
      if (e.method === "run.reply") replies.push(e.params);
    });
    m = mount(app.deps);
    await m.waitForText("idle");
    await m.type("Summarize @a.txt");
    await m.press(KEYS.enter);
    await m.waitForText("waiting for approval"); // the run waits here, after its first reply
    const u = replies[0]!.usage;
    expect(u.input_tokens).toBeGreaterThan(0);
    await m.waitForText(`ctx ${u.input_tokens + u.output_tokens}/1M`);
    await m.press("n");
  });
});
