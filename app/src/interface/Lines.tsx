// KV cache: none; the interface never touches the bytes sent to the model.
// Draws pre-cut lines in a box of fixed height, so every frame's size is known before Ink lays it
// out. A line still too wide is cut here with the theme's `more`, so Ink never adds its own `…`
// (which the ASCII fallback must not show).

import { Box, Text } from "ink";
import { truncate } from "./format.ts";
import { useTheme, type Line } from "./theme.ts";

/** The spans that fit `width` columns, the last one cut with `more`. */
export function fitLine(line: Line, width: number, more: string): Line {
  let room = width;
  const out: Line = [];
  for (const s of line) {
    const w = Bun.stringWidth(s.text);
    if (w <= room) {
      out.push(s);
      room -= w;
      continue;
    }
    out.push({ ...s, text: truncate(s.text, room, more) });
    break;
  }
  return out;
}

export function Lines(props: { lines: Line[]; height: number; width: number }) {
  const theme = useTheme();
  const shown = props.lines.slice(0, Math.max(0, props.height));
  return (
    <Box flexDirection="column" height={Math.max(0, props.height)} width={props.width} overflow="hidden">
      {shown.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line.length === 0
            ? " "
            : fitLine(line, props.width, theme.more).map((s, j) => (
                <Text key={j} color={s.color} dimColor={s.dim} bold={s.bold} inverse={s.inverse}>
                  {s.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}
