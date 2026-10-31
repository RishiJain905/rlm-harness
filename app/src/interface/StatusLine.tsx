// KV cache: none; the interface never touches the bytes sent to the model.
// The one-line status: statusModel's segments, dropped by layoutStatus until they fit.

import { layoutStatus, truncate, type StatusSegment } from "./format.ts";
import { Lines } from "./Lines.tsx";
import { toneColor, useTheme, type Line } from "./theme.ts";

export function StatusLine(props: { segments: StatusSegment[]; width: number }) {
  const theme = useTheme();
  const kept = layoutStatus(props.segments, props.width);
  const line: Line = [];
  let room = props.width;
  kept.forEach((seg, i) => {
    if (i > 0 && room > 3) {
      line.push({ text: " | ", dim: true });
      room -= 3;
    }
    const text = truncate(seg.text, room, theme.more);
    room -= Bun.stringWidth(text);
    line.push({ text, color: toneColor(theme, seg.tone), bold: seg.id === "state" });
  });
  return <Lines lines={[line]} height={1} width={props.width} />;
}
