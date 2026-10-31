// KV cache: none; the interface never touches the bytes sent to the model.
// /help: the commands from COMMANDS, /quit, and the key table.

import { useInput } from "ink";
import { useState } from "react";
import { wrapText } from "../format.ts";
import { span, type Line } from "../theme.ts";
import { Frame } from "./common.tsx";
import { COMMANDS, KEYS, QUIT, type ScreenProps } from "./index.ts";

export function HelpScreen(props: ScreenProps) {
  const [top, setTop] = useState(0);
  const body: Line[] = [[span("Commands", { bold: true })]];
  for (const c of [...COMMANDS, QUIT]) body.push([span(`  /${c.name}`.padEnd(16), { bold: true }), span(c.summary)]);
  body.push([], [span("Keys", { bold: true })]);
  for (const [k, what] of KEYS) {
    const lines = wrapText(what, Math.max(10, props.width - 22));
    lines.forEach((l, i) => body.push([span(i === 0 ? `  ${k}`.padEnd(22) : " ".repeat(22), { bold: i === 0 }), span(l)]));
  }
  body.push([], [span("Each question is a new run: @file reads those files, and a question with no mention works on this folder.", { dim: true })]);
  const room = Math.max(1, props.height - 2);
  const max = Math.max(0, body.length - room);
  useInput(
    (_input, key) => {
      if (key.escape) props.close();
      else if (key.upArrow) setTop((t) => Math.max(0, t - 1));
      else if (key.downArrow) setTop((t) => Math.min(max, t + 1));
      else if (key.pageUp) setTop((t) => Math.max(0, t - room));
      else if (key.pageDown) setTop((t) => Math.min(max, t + room));
    },
    { isActive: props.active },
  );
  return <Frame title="/help" hint="Esc closes  Up/Down scroll" body={body.slice(Math.min(top, max))} width={props.width} height={props.height} />;
}
