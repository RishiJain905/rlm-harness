// KV cache: none; the interface never touches the bytes sent to the model.
// /runs: past runs from every runs.jsonl under the runs folder, newest first. Enter replays one
// read-only through the same Transcript, SubcallPanel and SubcallView as a live run: no cancel,
// no approvals, Esc returns to the list.

import { Box, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { runsDir } from "../../paths.ts";
import { formatCost } from "../format.ts";
import { Lines } from "../Lines.tsx";
import { listRuns, readRun, RUN_LOG_FORMAT, type RunSummary } from "../runs.ts";
import { viewFromRecord, type RunView } from "../store.ts";
import { allRows, SubcallPanel, type PanelState } from "../SubcallPanel.tsx";
import { SubcallView } from "../SubcallView.tsx";
import { Transcript, transcriptLines } from "../Transcript.tsx";
import { paint, span, useTheme, type Line } from "../theme.ts";
import { fit, Frame, listLines } from "./common.tsx";
import type { ScreenProps } from "./index.ts";

export const OTHER_FORMAT = "written by another format version";

function date(seconds: number): string {
  if (!seconds) return "????-??-?? ??:??";
  const d = new Date(seconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function runRow(r: RunSummary, more: string): string {
  // the row names the format; Enter says it was written by another format version
  const status = r.format !== RUN_LOG_FORMAT ? `format ${r.format}` : r.infraKind ? `failed:${r.infraKind}` : "ok";
  const text = r.text.replace(/\s+/g, " ");
  const start = text.length > 40 ? `${text.slice(0, 40 - more.length)}${more}` : text.padEnd(40);
  return `${date(r.startedAt)}  ${r.mode.padEnd(4)}  ${r.root.padEnd(24)}  ${formatCost(r.costUsd).padStart(8)}  ${String(r.turns).padStart(5)}  ${start}  ${status}`;
}

export function RunsScreen(props: ScreenProps) {
  const theme = useTheme();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [sel, setSel] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [replay, setReplay] = useState<RunView | null>(null);
  useEffect(() => {
    let live = true;
    listRuns(runsDir(props.deps.home)).then(
      (list) => live && setRuns(list),
      (err: unknown) => live && setMessage(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [props.deps.home]);

  useInput(
    (_input, key) => {
      if (key.escape) props.close();
      else if (key.upArrow) setSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setSel((s) => Math.min(Math.max(0, (runs?.length ?? 1) - 1), s + 1));
      else if (key.return && runs?.[sel]) {
        const r = runs[sel];
        if (r.format !== RUN_LOG_FORMAT) return setMessage(`That run was ${OTHER_FORMAT} (format ${r.format}); this rlmh reads format ${RUN_LOG_FORMAT}.`);
        readRun(r).then(
          (record) => {
            setMessage(null);
            setReplay(viewFromRecord(record as Record<string, any>));
          },
          (err: unknown) => setMessage(err instanceof Error ? err.message : String(err)),
        );
      }
    },
    { isActive: props.active && replay === null },
  );

  if (replay) return <Replay view={replay} width={props.width} height={props.height} active={props.active} onClose={() => setReplay(null)} />;

  const w = props.width;
  const body: Line[] = [];
  if (runs === null && !message) body.push([span("Reading the run log...", { dim: true })]);
  else if (runs?.length === 0) body.push([span("No runs yet.", { dim: true })]);
  else if (runs) {
    body.push([span(fit(`${"date".padEnd(16)}  mode  ${"root model".padEnd(24)}  ${"cost".padStart(8)}  turns  ${"question or task".padEnd(40)}  status`, w, theme), { dim: true })]);
    const rows: Line[] = runs.map((r) => [span(fit(runRow(r, theme.more), w, theme), { color: r.infraKind && r.format === RUN_LOG_FORMAT ? paint(theme, "red") : undefined })]);
    body.push(...listLines(rows, sel, Math.max(1, props.height - 5)));
  }
  if (message) body.push([span(fit(message, w, theme), { color: paint(theme, "yellow") })]);
  return <Frame title="/runs" hint="Up/Down  Enter replays  Esc closes" body={body} width={w} height={props.height} />;
}

/** One past run, read-only: transcript (PageUp/PageDown), the panel (Tab), a row's view (Enter). */
function Replay(props: { view: RunView; width: number; height: number; active: boolean; onClose(): void }) {
  const theme = useTheme();
  const { view, width } = props;
  const [focus, setFocus] = useState<"transcript" | "panel">("transcript");
  const [panel, setPanel] = useState<PanelState>({ selected: 0, open: {} });
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [scroll, setScroll] = useState(0);
  const body = props.height - 2;
  const panelHeight = view.blocks.length > 0 ? Math.max(4, Math.floor(body / 2)) : 0;
  const tHeight = Math.max(0, body - panelHeight);
  const lines = useMemo(() => transcriptLines(view.entries, width, theme, { full: false, now: view.now }), [view, width, theme]);
  const rows = allRows(view.blocks);
  const row = openRow === null ? undefined : rows.find((r) => r.key === openRow);

  useInput(
    (_input, key) => {
      if (key.escape) {
        if (focus === "panel") setFocus("transcript");
        else props.onClose();
      } else if (key.tab && view.blocks.length > 0 && focus === "transcript") setFocus("panel");
      else if (key.pageUp) setScroll((s) => Math.min(Math.max(0, lines.length - tHeight), s + Math.max(1, tHeight - 1)));
      else if (key.pageDown) setScroll((s) => Math.max(0, s - Math.max(1, tHeight - 1)));
      else if (key.end) setScroll(0);
    },
    { isActive: props.active && !row },
  );

  const title: Line = [span(fit(`${theme.rule}${theme.rule} run ${view.runId ?? "?"} (read-only) `, width, theme), { bold: true })];
  const hint: Line = [span(fit(focus === "panel" ? "Up/Down  Enter opens  Esc back" : "PageUp/PageDown scroll  Tab sub-calls  Esc back to the list", width, theme), { dim: true })];
  if (row) {
    const step = (dir: -1 | 1) => {
      const at = rows.findIndex((r) => r.key === row.key);
      const next = rows[Math.max(0, Math.min(rows.length - 1, at + dir))];
      if (next) setOpenRow(next.key);
    };
    return (
      <Box flexDirection="column" width={width} height={props.height}>
        <Lines lines={[title]} height={1} width={width} />
        <SubcallView
          key={row.key}
          row={row}
          block={view.blocks.find((b) => b.id === row.batchId)}
          cellCode={view.cellCode}
          now={view.now}
          width={width}
          height={props.height - 1}
          active={props.active}
          onClose={() => setOpenRow(null)}
          onStep={step}
        />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width={width} height={props.height}>
      <Lines lines={[title]} height={1} width={width} />
      <Transcript lines={lines} scroll={scroll} width={width} height={tHeight} />
      {panelHeight > 0 ? (
        <SubcallPanel
          blocks={view.blocks}
          state={panel}
          onState={setPanel}
          focused={props.active && focus === "panel"}
          now={view.now}
          width={width}
          height={panelHeight}
          onOpen={setOpenRow}
          onLeave={() => setFocus("transcript")}
        />
      ) : null}
      <Lines lines={[hint]} height={1} width={width} />
    </Box>
  );
}
