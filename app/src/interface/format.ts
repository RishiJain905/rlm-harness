// KV cache: none; the interface never touches the bytes sent to the model.
// Pure display helpers for the interactive view: number and time formats, the glyph sets, the
// scrolling window, the screen and status-line layout, and the text cleaning that keeps model and
// tool output from breaking the terminal. Nothing here imports Ink.

export type Tone = "ok" | "warn" | "high";
export type StatusId = "state" | "root" | "sub" | "ctx" | "cost" | "cache" | "budget" | "mode";
export interface StatusSegment {
  id: StatusId;
  text: string;
  tone?: Tone;
}
export interface Glyphs {
  border: "round" | "classic";
  spinner: readonly string[];
  full: string;
  empty: string;
  on: string;
  off: string;
  more: string;
}

/** One decimal under 100 units, none from 100. */
function scale(value: number): number {
  return value < 100 ? Math.round(value * 10) / 10 : Math.round(value);
}

/** `999`, `1k`, `12.3k`, `123k`, `1M`, `1.2M`. A value that rounds to 1000k prints as `1M`. */
export function formatTokens(n: number): string {
  if (!(n > 0)) return "0";
  const whole = Math.round(n);
  if (whole < 1000) return String(whole);
  const k = scale(n / 1e3);
  if (k < 1000) return `${k}k`;
  return `${scale(n / 1e6)}M`;
}

/** Under $1 four decimals (`$0.0123`), from $1 two (`$1.23`). */
export function formatCost(usd: number): string {
  if (!(usd > 0)) return "$0.0000";
  const four = usd.toFixed(4);
  if (usd < 1 && Number(four) < 1) return `$${four}`;
  return `$${usd.toFixed(2)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `3.2s`, `1m05s`, `1h02m`. */
export function formatDuration(seconds: number): string {
  if (!(seconds > 0)) return "0.0s";
  const tenths = Math.round(seconds * 10);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const s = Math.max(60, Math.floor(seconds)); // 59.97 rounds up to a minute
  if (s < 3600) return `${Math.floor(s / 60)}m${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}m`;
}

/** The status line's running clock, floored: `0:12`, `12:05`, `1:02:03`. */
export function formatClock(seconds: number): string {
  const s = seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = pad2(s % 60);
  return h > 0 ? `${h}:${pad2(m)}:${ss}` : `${m}:${ss}`;
}

/**
 * Unicode glyphs or the ASCII fallback. `RLMH_ASCII=1` forces ASCII. On win32 only terminals known
 * to draw box characters and braille get Unicode (a legacy console window does not); elsewhere
 * everything but the Linux virtual console does.
 */
export function unicodeSupported(env: Record<string, string | undefined>, platform: string): boolean {
  if (env.RLMH_ASCII === "1") return false;
  if (platform === "win32") {
    return (
      (env.WT_SESSION ?? "") !== "" ||
      env.TERM_PROGRAM === "vscode" ||
      env.ConEmuANSI === "ON" ||
      env.TERM === "xterm-256color" ||
      env.TERM === "alacritty"
    );
  }
  return env.TERM !== "linux";
}

const UNICODE_GLYPHS: Glyphs = {
  border: "round",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  full: "█",
  empty: "░",
  on: "●",
  off: "○",
  more: "…",
};

const ASCII_GLYPHS: Glyphs = {
  border: "classic",
  spinner: ["|", "/", "-", "\\"],
  full: "#",
  empty: ".",
  on: "*",
  off: ".",
  more: "...",
};

export function glyphs(unicode: boolean): Glyphs {
  return unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

/**
 * Items `[start, end)` of `count` to show in `height` lines with `selected` inside. A `^ N more`
 * line is drawn when `above > 0` and a `v N more` line when `below > 0`, and those lines count
 * toward `height`. At height 1 or 2 (or less) no marker fits, so `above` and `below` are 0 and only
 * the items around the selection show. `above` and `below` are 0 for a list that fits.
 */
export function windowLines(count: number, selected: number, height: number): { start: number; end: number; above: number; below: number } {
  const n = Math.max(0, Math.floor(count));
  const h = Math.floor(height);
  if (n === 0 || !(h >= 1)) return { start: 0, end: 0, above: 0, below: 0 };
  if (n <= h) return { start: 0, end: n, above: 0, below: 0 };
  const sel = Math.min(n - 1, Math.max(0, Number.isFinite(selected) ? Math.floor(selected) : 0));
  const around = (visible: number): number => Math.min(n - visible, Math.max(0, sel - Math.floor(visible / 2)));
  if (h < 3) {
    const start = around(h);
    return { start, end: start + h, above: 0, below: 0 };
  }
  let visible = h - 2; // both markers
  let start = around(visible);
  if (start === 0) {
    visible = h - 1; // nothing above: the top marker's line goes to an item
    start = 0;
  } else if (start + visible === n) {
    visible = h - 1; // nothing below
    start = n - visible;
  }
  const end = start + visible;
  return { start, end, above: start, below: n - end };
}

/**
 * Rows for each part of the screen. The frame is `rows - 1` tall, because Ink repaints a whole
 * screen that is as tall as the terminal. Approval and menu take what they ask for but leave the
 * transcript at least 3 lines; the panel gets half of what is left (at least 4) when 7 are left.
 */
export function layoutHeights(
  rows: number,
  parts: { panel: boolean; approval: number; menu: number },
): { transcript: number; panel: number; approval: number; menu: number; prompt: number; status: number } {
  const prompt = 3;
  const status = 1;
  const avail = Math.max(0, Math.floor(rows) - 1 - prompt - status);
  const approval = Math.max(0, Math.min(Math.floor(parts.approval), avail - 3));
  const menu = Math.max(0, Math.min(Math.floor(parts.menu), avail - approval - 3));
  const free = Math.max(0, avail - approval - menu);
  const panel = parts.panel && free >= 7 ? Math.max(4, Math.floor(free / 2)) : 0;
  return { transcript: Math.max(0, free - panel), panel, approval, menu, prompt, status };
}

const SEPARATOR = " | ";
const DROP_ORDER: readonly StatusId[] = ["mode", "sub", "cache", "root", "cost", "ctx", "budget"];

/** The segments that fit `columns` joined with ` | `. `state` is never dropped, and order is kept. */
export function layoutStatus(segments: readonly StatusSegment[], columns: number): StatusSegment[] {
  const kept = [...segments];
  const width = (): number => kept.reduce((sum, s) => sum + Bun.stringWidth(s.text), 0) + SEPARATOR.length * Math.max(0, kept.length - 1);
  for (const id of DROP_ORDER) {
    if (width() <= columns) break;
    const at = kept.findIndex((s) => s.id === id);
    if (at >= 0) kept.splice(at, 1);
  }
  return kept;
}

/** `pct` is 0 to 100. */
export function contextTone(pct: number): Tone {
  if (!(pct >= 60)) return "ok";
  return pct < 85 ? "warn" : "high";
}

/** `rate` is 0 to 1. */
export function cacheTone(rate: number): Tone {
  if (rate >= 0.6) return "ok";
  return rate >= 0.2 ? "warn" : "high";
}

// OSC, DCS, SOS, PM and APC strings (ESC ] ... BEL or ST), then CSI (ESC [ params intermediates final).
// The string bodies stop at the next ESC, so scanning stays linear.
const ESCAPE_STRING = /\u001B[\]PX^_][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
// every C0 control but \t (09) and \n (0A), then DEL and the C1 controls
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Text that is safe to draw: no escape sequences or control characters; line ends are `\n`. */
export function sanitize(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(ESCAPE_STRING, "").replace(CSI, "").replace(CONTROLS, "");
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Tabs to spaces up to the next multiple of 4 columns. */
function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  const parts = line.split("\t");
  let out = parts[0] as string;
  let col = Bun.stringWidth(out);
  for (let i = 1; i < parts.length; i++) {
    const pad = 4 - (col % 4);
    const part = parts[i] as string;
    out += " ".repeat(pad) + part;
    col += pad + Bun.stringWidth(part);
  }
  return out;
}

/** Cuts `text` into pieces that are each at most `width` columns, never inside a grapheme. */
function hardBreak(text: string, width: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  let w = 0;
  for (const g of graphemes(text)) {
    const gw = Bun.stringWidth(g);
    if (w + gw > width && piece !== "") {
      pieces.push(piece);
      piece = "";
      w = 0;
    }
    piece += g;
    w += gw;
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}

function wrapLine(line: string, width: number): string[] {
  if (Bun.stringWidth(line) <= width) return [line];
  const out: string[] = [];
  let cur = "";
  let curW = 0;
  const flush = (): void => {
    if (cur.trim() !== "") out.push(cur.trimEnd());
    cur = "";
    curW = 0;
  };
  for (const token of line.match(/ +|[^ ]+/g) ?? []) {
    const w = Bun.stringWidth(token);
    if (token[0] === " ") {
      if (curW + w <= width) {
        cur += token;
        curW += w;
      } else {
        flush(); // spaces at a break are dropped
      }
      continue;
    }
    if (curW + w <= width) {
      cur += token;
      curW += w;
      continue;
    }
    flush();
    if (w <= width) {
      cur = token;
      curW = w;
      continue;
    }
    const pieces = hardBreak(token, width);
    out.push(...pieces.slice(0, -1));
    cur = pieces[pieces.length - 1] as string;
    curW = Bun.stringWidth(cur);
  }
  flush();
  return out.length > 0 ? out : [""];
}

/**
 * `text` as lines of at most `width` display columns (`Bun.stringWidth`): sanitized, split at `\n`,
 * tabs expanded, wrapped at spaces, and words wider than `width` cut by grapheme. An empty line is
 * one empty string. One exception to the width promise: a double-width character cannot fit in
 * `width` 1, so it gets a line of its own.
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width) || 1);
  const lines: string[] = [];
  for (const line of sanitize(text).split("\n")) lines.push(...wrapLine(expandTabs(line), w));
  return lines;
}

/** `text` on one line (newlines and tabs become spaces), cut to `width` columns with `more` as the last characters. */
export function truncate(text: string, width: number, more: string): string {
  const w = Math.floor(width);
  if (!(w > 0)) return "";
  const line = sanitize(text).replace(/[\n\t]/g, " ");
  if (Bun.stringWidth(line) <= w) return line;
  const moreW = Bun.stringWidth(more);
  if (moreW >= w) return hardBreak(more, w)[0] ?? "";
  const budget = w - moreW;
  let cut = "";
  let used = 0;
  for (const g of graphemes(line)) {
    const gw = Bun.stringWidth(g);
    if (used + gw > budget) break;
    cut += g;
    used += gw;
  }
  return cut + more;
}
