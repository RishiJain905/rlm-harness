// KV cache: none; the interface never touches the bytes sent to the model.
// What the slash screens share: a frame (title, body, key hint) and a selectable list window.

import { Box } from "ink";
import { truncate, windowLines } from "../format.ts";
import { Lines } from "../Lines.tsx";
import { span, useTheme, type Line, type Theme } from "../theme.ts";

/** Title rule, the body cut to fit, and the key hint on the last line. */
export function Frame(props: { title: string; hint: string; body: Line[]; width: number; height: number }) {
  const theme = useTheme();
  const title = `${theme.rule}${theme.rule} ${props.title} `;
  const head: Line = [span(title, { bold: true }), span(theme.rule.repeat(Math.max(0, props.width - Bun.stringWidth(title))), { dim: true })];
  const bodyHeight = Math.max(0, props.height - 2);
  const body = props.body.slice(0, bodyHeight);
  const pad = Array.from({ length: bodyHeight - body.length }, (): Line => []);
  const hint: Line = [span(truncate(props.hint, props.width, theme.more), { dim: true })];
  return (
    <Box flexDirection="column" width={props.width} height={props.height}>
      <Lines lines={[head, ...body, ...pad, hint]} height={props.height} width={props.width} />
    </Box>
  );
}

/** A list window around `selected`: each item one line, the selected one inverse. */
export function listLines(items: Line[], selected: number, height: number): Line[] {
  const w = windowLines(items.length, selected, height);
  const out: Line[] = [];
  if (w.above > 0) out.push([span(`  ^ ${w.above} more`, { dim: true })]);
  for (let i = w.start; i < w.end; i++) {
    const item = items[i]!;
    out.push(i === selected ? [span(">", { bold: true }), ...item.map((s) => ({ ...s, inverse: true }))] : [span(" "), ...item]);
  }
  if (w.below > 0) out.push([span(`  v ${w.below} more`, { dim: true })]);
  return out;
}

/** Cuts a row's text to the width, keeping the leading marker column. */
export function fit(text: string, width: number, theme: Theme): string {
  return truncate(text, Math.max(0, width - 1), theme.more);
}
