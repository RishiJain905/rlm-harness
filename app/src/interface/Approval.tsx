// KV cache: none; the interface never touches the bytes sent to the model.
// The inline approval prompt for the head of the queue, above the prompt box: y allows once,
// a allows for this run, n denies. Up/Down move the highlight and Enter confirms it; it starts on
// Deny, so Enter denies. Esc (deny) is App's, first in its order.

import { Box, useInput } from "ink";
import { useState } from "react";
import type { ApprovalParams, ApprovalResult } from "../protocol.ts";
import { truncate, wrapText } from "./format.ts";
import { Lines } from "./Lines.tsx";
import { paint, span, useTheme, type Line } from "./theme.ts";

const DETAIL_MAX = 600;
const KIND_COLORS = { write: "yellow", shell: "magenta", network: "blue" } as const;

/** What `a` covers (D-14). */
export function rememberText(p: ApprovalParams): string {
  if (p.kind === "write") return `every later write ${p.inside_workspace ? "inside" : "outside"} the workspace in this run`;
  if (p.kind === "shell") return "every later shell command in this run";
  return "this host, for the rest of this run";
}

const CHOICES: { key: "y" | "a" | "n"; label: (p: ApprovalParams) => string; result: ApprovalResult }[] = [
  { key: "y", label: () => "Allow once", result: { allow: true, remember_for_run: false } },
  { key: "a", label: (p) => `Allow for this run: ${rememberText(p)}`, result: { allow: true, remember_for_run: true } },
  { key: "n", label: () => "Deny", result: { allow: false, remember_for_run: false } },
];
const DENY_INDEX = 2;

/** The lines inside the border; at most `maxLines`, cutting the detail first. */
export function approvalLines(p: ApprovalParams, waiting: number, width: number, maxLines: number, highlight: number, color: (c: string) => string | undefined): Line[] {
  const head: Line = [
    span(p.kind, { bold: true, color: color(KIND_COLORS[p.kind]) }),
    span(`  turn ${p.turn}`, { dim: true }),
    ...(p.inside_workspace ? [] : [span("  outside the workspace", { color: color("yellow") })]),
    ...(waiting > 0 ? [span(`  +${waiting} waiting`, { dim: true })] : []),
  ];
  const detail = p.detail.length > DETAIL_MAX ? `${p.detail.slice(0, DETAIL_MAX)} (+${p.detail.length - DETAIL_MAX} chars)` : p.detail;
  let choices: Line[] = CHOICES.map((c, i) => [span(truncate(`${i === highlight ? ">" : " "} ${c.key}  ${c.label(p)}`, width, "..."), { inverse: i === highlight })]);
  // too little room for a line each: one line, the highlighted choice marked
  if (maxLines < 2 + choices.length) choices = [CHOICES.map((c, i) => span(`${c.key} ${c.key === "a" ? "this run" : c.label(p).split(" ")[0]!.toLowerCase()}  `, { inverse: i === highlight }))];
  let detailLines = wrapText(detail, width);
  const room = Math.max(0, maxLines - 1 - choices.length);
  if (detailLines.length > room) detailLines = [...detailLines.slice(0, Math.max(0, room - 1)), `(+${detailLines.length - room + 1} more lines)`].slice(0, room);
  return [head, ...detailLines.map((l) => [span(l)]), ...choices];
}

/** The height the prompt wants at this width, borders included. */
export function approvalHeight(p: ApprovalParams, width: number): number {
  return 2 + approvalLines(p, 0, width - 4, Number.MAX_SAFE_INTEGER, DENY_INDEX, () => undefined).length;
}

export function Approval(props: { params: ApprovalParams; waiting: number; width: number; height: number; active: boolean; onAnswer(r: ApprovalResult): void }) {
  const theme = useTheme();
  const [highlight, setHighlight] = useState(DENY_INDEX);
  useInput(
    (input, key) => {
      const choice = CHOICES.find((c) => c.key === input.toLowerCase());
      if (choice) props.onAnswer(choice.result);
      else if (key.upArrow) setHighlight((h) => (h + CHOICES.length - 1) % CHOICES.length);
      else if (key.downArrow) setHighlight((h) => (h + 1) % CHOICES.length);
      else if (key.return) props.onAnswer(CHOICES[highlight]!.result);
    },
    { isActive: props.active },
  );
  const inner = props.width - 4;
  const lines = approvalLines(props.params, props.waiting, inner, props.height - 2, highlight, (c) => paint(theme, c));
  return (
    <Box borderStyle={theme.border} borderColor={paint(theme, "yellow")} paddingX={1} height={props.height} width={props.width} flexDirection="column">
      <Lines lines={lines} height={props.height - 2} width={inner} />
    </Box>
  );
}
