// KV cache: none; the interface never touches the bytes sent to the model.
// /permissions: the next run's mode, held in App for this session and never saved (a lasting
// default is /settings, permissions.mode), so bypass can't stick by accident; then this run's
// run.permission events.

import { useInput } from "ink";
import { useState } from "react";
import { wrapText } from "../format.ts";
import { permissionLine } from "../store.ts";
import { paint, span, useTheme, type Line } from "../theme.ts";
import { Frame, listLines } from "./common.tsx";
import type { ScreenProps } from "./index.ts";

/** The v0-design table. */
const MODES: readonly { mode: string; asks: string }[] = [
  { mode: "default", asks: "asks for writes, shell commands and network" },
  { mode: "accept-edits", asks: "asks for shell commands, network, and writes outside the workspace" },
  { mode: "bypass", asks: "asks for nothing" },
];
const ENGINE_CAP = 200;

export function PermissionsScreen(props: ScreenProps) {
  const theme = useTheme();
  const [sel, setSel] = useState(Math.max(0, MODES.findIndex((m) => m.mode === props.permissionMode)));
  useInput(
    (_input, key) => {
      if (key.escape) props.close();
      else if (key.upArrow) setSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setSel((s) => Math.min(MODES.length - 1, s + 1));
      else if (key.return) props.setPermissionMode(MODES[sel]!.mode);
    },
    { isActive: props.active },
  );
  const rows: Line[] = MODES.map((m) => [
    span(`${m.mode === props.permissionMode ? theme.on : theme.off} ${m.mode}`.padEnd(16), { bold: true, color: m.mode === "bypass" ? paint(theme, "red") : undefined }),
    span(m.asks),
  ]);
  const body: Line[] = [[span("Mode for the next run (this session only; /settings permissions.mode sets the default)", { dim: true })], ...listLines(rows, sel, MODES.length, theme)];
  if (props.permissionMode === "bypass" || MODES[sel]!.mode === "bypass") {
    for (const l of wrapText("bypass asks nothing: model-written code can write anywhere, run any command and reach any host.", props.width)) {
      body.push([span(l, { bold: true, color: paint(theme, "red") })]);
    }
  }
  body.push([], [span("This run", { bold: true })]);
  const head = body.length;
  const events = props.view.permissions;
  if (events.length === 0) body.push([span("  No permission decisions yet.", { dim: true })]);
  for (const p of events) body.push([span(`  ${permissionLine(p)}`, { color: p.allowed ? undefined : paint(theme, "red") })]);
  if (events.length >= ENGINE_CAP) body.push([span(`  first ${ENGINE_CAP} shown`, { dim: true })]);
  // keep the newest events on screen when the list is long
  const room = Math.max(0, props.height - 2);
  const shown = body.length > room && room > head ? [...body.slice(0, head), ...body.slice(body.length - (room - head))] : body;
  return <Frame title="/permissions" hint="Up/Down  Enter chooses  Esc closes" body={shown} width={props.width} height={props.height} />;
}
