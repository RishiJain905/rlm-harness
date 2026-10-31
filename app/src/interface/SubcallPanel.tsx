// KV cache: none; the interface never touches the bytes sent to the model.
// The sub-call panel: one block per llm_batch fan-out (a single llm() is a block of one). A running
// block shows a header and a row per call; a finished block collapses to one line until Enter
// expands it. Rows window around the selection with `^ N more` / `v N more` lines.

import { useInput } from "ink";
import { formatDuration, formatTokens, truncate, windowLines } from "./format.ts";
import { Lines } from "./Lines.tsx";
import type { Block, SubcallRow } from "./store.ts";
import { paint, span, useTheme, type Line, type Theme } from "./theme.ts";

export interface PanelState {
  selected: number;
  /** Enter's choice per block id; a block without one is open while it runs. */
  open: Record<string, boolean>;
}

export type PanelItem = { kind: "block"; block: Block } | { kind: "row"; block: Block; row: SubcallRow };

const WORDS: Record<SubcallRow["status"], string> = { queued: "queued", streaming: "streaming", done: "done", error: "err", rejected: "rej" };

export function blockFinished(b: Block): boolean {
  return b.rows.length > 0 && b.rows.every((r) => r.status === "done" || r.status === "error" || r.status === "rejected") && (b.rows.length >= b.size || b.rows.some((r) => r.status === "rejected"));
}

export function isOpen(b: Block, state: PanelState): boolean {
  return state.open[b.id] ?? !blockFinished(b);
}

export function panelItems(blocks: readonly Block[], state: PanelState): PanelItem[] {
  const items: PanelItem[] = [];
  for (const block of blocks) {
    items.push({ kind: "block", block });
    if (isOpen(block, state)) for (const row of block.rows) items.push({ kind: "row", block, row });
  }
  return items;
}

/** Every row, in panel order, for the sub-call view's Left/Right. */
export function allRows(blocks: readonly Block[]): SubcallRow[] {
  return blocks.flatMap((b) => b.rows);
}

/** Seconds so far: exact once finished, else since call.start. */
export function rowSeconds(row: SubcallRow, now: number): number | null {
  if (row.seconds !== null) return row.seconds;
  return row.startedAt !== null ? Math.max(0, (now - row.startedAt) / 1000) : null;
}

export function rowTokens(row: SubcallRow): { input: string; output: string } {
  if (row.usage) return { input: formatTokens(row.usage.input_tokens), output: formatTokens(row.usage.output_tokens) };
  const promptChars = row.prompt.length || row.promptChars;
  return { input: `~${formatTokens(Math.ceil(promptChars / 4))}`, output: `~${formatTokens(Math.ceil(row.text.length / 4))}` };
}

export function statusColor(theme: Theme, status: SubcallRow["status"]): string | undefined {
  return paint(theme, { queued: undefined, streaming: "cyan", done: "green", error: "red", rejected: "yellow" }[status]);
}

function dot(theme: Theme, row: SubcallRow, now: number): string {
  if (row.status === "streaming") return theme.spinner[Math.floor(now / 100) % theme.spinner.length]!;
  return row.status === "queued" ? theme.off : theme.on;
}

function rowLine(row: SubcallRow, now: number, width: number, theme: Theme, selected: boolean): Line {
  const id = row.subcallId === null ? "#--" : `#${String(row.subcallId).padStart(2, "0")}`;
  const word = WORDS[row.status].padEnd(9);
  let rest: string;
  if (row.status === "rejected") {
    rest = row.error ?? "refused";
  } else {
    const t = rowTokens(row);
    const s = rowSeconds(row, now);
    rest = `${t.input} in ${t.output} out  ${s === null ? "" : formatDuration(s)}  ${row.prompt || ""}`;
  }
  const head = `  ${dot(theme, row, now)} ${id} `;
  const tail = truncate(`  ${rest}`, Math.max(0, width - Bun.stringWidth(head) - 9), theme.more);
  return [
    span(head, { inverse: selected }),
    span(word.slice(0, 9), { color: statusColor(theme, row.status), inverse: selected }),
    span(tail, { inverse: selected, dim: row.status === "queued" }),
  ];
}

function blockLine(block: Block, open: boolean, now: number, width: number, theme: Theme, selected: boolean): Line {
  const finished = blockFinished(block);
  const rejected = block.rows.find((r) => r.status === "rejected");
  let text: string;
  if (rejected) {
    text = `batch ${block.id}  ${block.size} prompt${block.size === 1 ? "" : "s"}  rejected: ${rejected.error ?? "refused"}`;
  } else {
    const done = block.rows.filter((r) => r.status === "done").length;
    const errs = block.rows.filter((r) => r.status === "error").length;
    const where = `turn ${block.origin.turn} line ${block.origin.line ?? "?"}`;
    const secs = finished ? Math.max(0, ...block.rows.map((r) => r.seconds ?? 0)) : null;
    text = `batch ${block.id}  ${block.size} call${block.size === 1 ? "" : "s"}  ${done}/${block.size} done${errs ? `, ${errs} err` : ""}  ${where}${secs !== null ? `  ${formatDuration(secs)}` : ""}${finished && !open ? "  (Enter expands)" : ""}`;
  }
  const mark = finished ? theme.on : theme.spinner[Math.floor(now / 100) % theme.spinner.length]!;
  const color = rejected ? "yellow" : block.rows.some((r) => r.status === "error") ? "red" : finished ? "green" : "cyan";
  return [span(`${mark} `, { color: paint(theme, color), inverse: selected }), span(truncate(text, Math.max(0, width - 2), theme.more), { bold: !finished, inverse: selected })];
}

/** The panel's lines: a title rule, then the items around the selection. */
export function panelLines(p: { blocks: readonly Block[]; state: PanelState; focused: boolean; now: number; width: number; height: number; theme: Theme }): Line[] {
  const { theme, width } = p;
  const hint = p.focused ? " Up/Down  Enter opens  Tab back " : " Tab selects ";
  const title = ` sub-calls `;
  const fill = Math.max(0, width - Bun.stringWidth(title) - Bun.stringWidth(hint) - 2);
  const lines: Line[] = [[span(`${theme.rule}${theme.rule}${title}`, { dim: true }), span(theme.rule.repeat(fill), { dim: true }), span(hint, { dim: true })]];
  const items = panelItems(p.blocks, p.state);
  const selected = p.focused ? Math.min(p.state.selected, items.length - 1) : lastBlockStart(items);
  const w = windowLines(items.length, selected, Math.max(0, p.height - 1));
  if (w.above > 0) lines.push([span(`  ^ ${w.above} more`, { dim: true })]);
  for (let i = w.start; i < w.end; i++) {
    const item = items[i]!;
    const sel = p.focused && i === selected;
    lines.push(item.kind === "block" ? blockLine(item.block, isOpen(item.block, p.state), p.now, width, theme, sel) : rowLine(item.row, p.now, width, theme, sel));
  }
  if (w.below > 0) lines.push([span(`  v ${w.below} more`, { dim: true })]);
  return lines;
}

/** Unfocused, the window starts at the newest block's header. */
function lastBlockStart(items: PanelItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === "block") return i;
  return 0;
}

export function SubcallPanel(props: {
  blocks: readonly Block[];
  state: PanelState;
  onState(s: PanelState): void;
  focused: boolean;
  now: number;
  width: number;
  height: number;
  onOpen(rowKey: string): void;
  onLeave(): void;
}) {
  const theme = useTheme();
  const items = panelItems(props.blocks, props.state);
  useInput(
    (input, key) => {
      const sel = Math.min(props.state.selected, Math.max(0, items.length - 1));
      if (key.upArrow) props.onState({ ...props.state, selected: Math.max(0, sel - 1) });
      else if (key.downArrow) props.onState({ ...props.state, selected: Math.min(items.length - 1, sel + 1) });
      else if (key.tab) props.onLeave();
      else if (key.return) {
        const item = items[sel];
        if (item?.kind === "row") props.onOpen(item.row.key);
        else if (item) props.onState({ ...props.state, selected: sel, open: { ...props.state.open, [item.block.id]: !isOpen(item.block, props.state) } });
      }
    },
    { isActive: props.focused },
  );
  const lines = panelLines({ ...props, theme });
  return <Lines lines={lines} height={props.height} width={props.width} />;
}
