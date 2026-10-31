// KV cache: none; the interface never touches the bytes sent to the model.
// The run's transcript as a tail window (no <Static>, so every frame is a whole screen):
// PageUp/PageDown scroll it, End follows the tail, Ctrl+O shows entries in full.

import { wrapText } from "./format.ts";
import { Lines } from "./Lines.tsx";
import type { Entry } from "./store.ts";
import { paint, span, type Line, type Theme } from "./theme.ts";

const CAPS = { reply: 6, reasoning: 2, code: 8, output: 8, answer: 8 };

/** Every entry as lines cut to `width`; long parts end with `… +N lines` unless `full`. */
export function transcriptLines(entries: readonly Entry[], width: number, theme: Theme, opts: { full: boolean; now: number }): Line[] {
  const out: Line[] = [];
  const w = Math.max(1, width);
  const block = (text: string, indent: string, cap: number, style: Omit<Line[number], "text"> = {}, tail = false) => {
    let lines = wrapText(text, Math.max(1, w - indent.length));
    if (lines.length === 1 && lines[0] === "") return;
    let more = 0;
    if (!opts.full && lines.length > cap) {
      more = lines.length - cap;
      lines = tail ? lines.slice(-cap) : lines.slice(0, cap);
    }
    const moreLine: Line = [span(`${indent}${theme.more} +${more} lines`, { dim: true })];
    if (more && tail) out.push(moreLine);
    for (const l of lines) out.push([span(indent), span(l, style)]);
    if (more && !tail) out.push(moreLine);
  };
  const spinner = theme.spinner[Math.floor(opts.now / 100) % theme.spinner.length]!;

  for (const e of entries) {
    switch (e.kind) {
      case "question":
        block(`> ${e.text}`, "", Number.MAX_SAFE_INTEGER, { bold: true });
        block(`(${e.detail})`, "  ", 1, { dim: true });
        break;
      case "started":
        block(e.text, "", 3, { dim: true });
        break;
      case "reply":
        out.push([]);
        out.push([span(`${theme.on} turn ${e.turn}`, { bold: true }), ...(e.live ? [span(` ${spinner}`, { color: paint(theme, "cyan") })] : [])]);
        block(e.reasoning, "  ", CAPS.reasoning, { dim: true }, e.live);
        block(e.text, "  ", CAPS.reply, {}, e.live);
        break;
      case "cell":
        if (e.code !== null) block(e.code, `  ${theme.bar} `, CAPS.code, { color: paint(theme, "cyan") });
        block(e.output, "    ", CAPS.output);
        if (e.error) block(e.error, "    ", CAPS.output, { color: paint(theme, "red") });
        for (const n of e.notes) block(`(${n})`, "    ", 2, { color: paint(theme, "yellow") });
        break;
      case "permission":
        block(e.text, "  ", 3, { color: paint(theme, e.allowed ? "yellow" : "red") });
        break;
      case "answer":
        out.push([]);
        out.push([span("Answer", { bold: true, color: paint(theme, "green") })]);
        block(e.text, "  ", CAPS.answer);
        break;
      case "error":
        block(e.text, "", 6, { color: paint(theme, "red") });
        for (const l of e.lines) block(l, "  ", 2, { dim: true });
        break;
      case "note":
        block(e.text, "", 6, e.tone === "info" ? { dim: true } : { color: paint(theme, e.tone === "warn" ? "yellow" : "red") });
        break;
    }
  }
  return out;
}

/** The lines shown: the tail, or `scroll` lines above it, with a marker when lines are hidden. */
export function Transcript(props: { lines: Line[]; scroll: number; width: number; height: number; theme: Theme }) {
  const { lines, height, theme } = props;
  let shown: Line[];
  if (lines.length <= height) {
    shown = lines;
  } else {
    const scroll = Math.min(props.scroll, lines.length - height);
    const end = lines.length - scroll;
    shown = lines.slice(end - height, end);
    // a marker takes the place of a line, so it counts that line too
    const above = end - height;
    if (above > 0 && height >= 2) shown[0] = [span(`^ ${above + 1} more (PageUp)`, { dim: true })];
    if (scroll > 0 && height >= 3) shown[shown.length - 1] = [span(`v ${scroll + 1} more (End follows)`, { dim: true })];
  }
  return <Lines lines={shown} height={height} width={props.width} />;
}

/** Shown while nothing has run yet. */
export function bannerLines(info: { app: string; engine: string | null; folder: string; root: string; sub: string }, width: number): Line[] {
  const text = [
    `rlmh ${info.app}${info.engine ? `   engine ${info.engine}` : ""}`,
    `folder ${info.folder}`,
    `root ${info.root}   sub ${info.sub}`,
    "Each question is a new run.",
    "@file reads those files; a question with no mention works on this folder. /help lists the commands.",
  ];
  return text.flatMap((t, i) => wrapText(t, width).map((l) => [span(l, i === 0 ? { bold: true } : { dim: i > 2 })]));
}
