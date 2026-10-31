// KV cache: none; the interface never touches the bytes sent to the model.
// /context: the last root request as a 40-cell bar over the window (system, first message, turns,
// tool def, output reserve, free), each with ~tokens (chars ÷ 4) and the provider's figure from
// the last reply; then the REPL's variables from run.vars, refreshed with r.

import { useInput } from "ink";
import { useEffect, useState } from "react";
import type { VarInfo } from "../../protocol.ts";
import { formatTokens } from "../format.ts";
import { contextBreakdown, isActive } from "../store.ts";
import { paint, span, useTheme, type Line } from "../theme.ts";
import { fit, Frame } from "./common.tsx";
import type { ScreenProps } from "./index.ts";

const CELLS = 40;
const COLORS = ["magenta", "blue", "cyan", "yellow", "gray"];

export function ContextScreen(props: ScreenProps) {
  const theme = useTheme();
  const { deps, view } = props;
  const runId = view.runId;
  const active = isActive(view.phase) && runId !== null;
  const [vars, setVars] = useState<{ list: VarInfo[] } | { error: string } | null>(null);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    if (!active || runId === null) return;
    let live = true;
    deps.session.vars(runId).then(
      (list) => live && setVars({ list }),
      (err: unknown) => live && setVars({ error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [active, runId, seq, deps.session]);
  useInput(
    (input, key) => {
      if (key.escape) props.close();
      else if (input === "r") setSeq((n) => n + 1);
    },
    { isActive: props.active },
  );

  const w = props.width;
  const body: Line[] = [];
  const request = runId !== null ? deps.session.gateway.lastRootRequest(runId) : undefined;
  if (!request) {
    body.push([span("No root request yet.", { dim: true })]);
  } else {
    const { segments, reserve, estimate } = contextBreakdown(request);
    const model = request.model;
    const window = deps.catalog.get(model.provider, model.model)?.context_window ?? null;
    const scale = window ?? estimate + reserve;
    const parts = [...segments.map((s, i) => ({ label: s.label, tokens: s.tokens, color: COLORS[i]! })), { label: "output reserve", tokens: reserve, color: COLORS[4]! }];
    const bar: Line = [];
    let used = 0;
    for (const p of parts) {
      const cells = Math.min(CELLS - used, Math.round((p.tokens / scale) * CELLS));
      if (cells > 0) bar.push(span(theme.full.repeat(cells), { color: paint(theme, p.color) }));
      used += Math.max(0, cells);
    }
    bar.push(span(theme.empty.repeat(Math.max(0, CELLS - used)), { dim: true }));
    body.push([span(`${model.provider}/${model.model}  window ${window ? formatTokens(window) : "unknown"}`, { bold: true })]);
    body.push(bar);
    for (const p of parts) {
      const approx = p.label === "output reserve" ? formatTokens(p.tokens) : `~${formatTokens(Math.round(p.tokens))}`;
      body.push([span(`${theme.full} `, { color: paint(theme, p.color) }), span(fit(`${p.label.padEnd(16)} ${approx}`, w - 2, theme))]);
    }
    const free = window !== null ? window - estimate - reserve : null;
    body.push([span(`${theme.empty} `, { dim: true }), span(`${"free".padEnd(16)} ${free === null ? "?" : `~${formatTokens(Math.max(0, Math.round(free)))}`}`)]);
    const reported = view.ctx && !view.ctx.estimated ? view.ctx.tokens : null;
    body.push([span(fit(`estimate ~${formatTokens(Math.round(estimate))} tokens; the provider reported ${reported === null ? "nothing yet" : `${formatTokens(reported)} (input + output of the last reply)`}`, w, theme), { dim: true })]);
  }
  body.push([], [span("Variables", { bold: true })]);
  if (!active) body.push([span("Variables exist only while a run is active.", { dim: true })]);
  else if (vars === null) body.push([span("Reading...", { dim: true })]);
  else if ("error" in vars) body.push([span(fit(vars.error, w, theme), { color: paint(theme, "red") })]);
  else if (vars.list.length === 0) body.push([span("No variables yet.", { dim: true })]);
  else {
    body.push([span(`${"name".padEnd(20)} ${"type".padEnd(12)} ${"len".padStart(8)} ${"chars".padStart(10)}`, { dim: true })]);
    for (const v of vars.list) body.push([span(fit(`${v.name.padEnd(20)} ${v.type.padEnd(12)} ${String(v.len ?? "-").padStart(8)} ${String(v.chars).padStart(10)}`, w, theme))]);
  }
  return <Frame title="/context" hint={active ? "r refreshes the variables  Esc closes" : "Esc closes"} body={body} width={w} height={props.height} />;
}
