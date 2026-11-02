// KV cache: none; the interface never touches the bytes sent to the model.
// The sub-call panel: one block per llm_batch fan-out (a single llm() is a block of one). A running
// block shows a header and a row per call; a finished block collapses to one line until Enter
// expands it. Rows window around the selection with `^ N more` / `v N more` lines. An rlm() child
// (D-160) is a block of its own; the blocks of the calls it made follow it, indented, and hide
// with it when it collapses.

import { useInput } from "ink";
import { formatDuration, formatTokens, truncate, windowLines } from "./format.ts";
import { Lines } from "./Lines.tsx";
import type { Block, SubcallRow } from "./store.ts";
import { paint, span, useTheme, type Line, type Theme } from "./theme.ts";

export interface PanelState {
  selected: number;
  /** Enter's choice per block (panelKey); a block without one is open while it runs. */
  open: Record<string, boolean>;
}

export type PanelItem = { kind: "block"; block: Block; depth: number } | { kind: "row"; block: Block; row: SubcallRow; depth: number };

const WORDS: Record<SubcallRow["status"], string> = { queued: "queued", streaming: "streaming", done: "done", error: "err", rejected: "rej" };

export function blockFinished(b: Block): boolean {
  return b.rows.length > 0 && b.rows.every((r) => r.status === "done" || r.status === "error" || r.status === "rejected") && (b.rows.length >= b.size || b.rows.some((r) => r.status === "rejected"));
}

/** A block's key for the panel's open state: a child's batch ids may repeat the root's. */
export function panelKey(b: Block): string {
  return b.child === null ? b.id : `rlm${b.child}/${b.id}`;
}

export function isOpen(b: Block, state: PanelState): boolean {
  return state.open[panelKey(b)] ?? !blockFinished(b);
}

/** The rlm() child a block is the row of, if it is one. */
function childOf(b: Block): number | null {
  return b.rows.find((r) => r.child !== null)?.child?.id ?? null;
}

/**
 * Blocks in panel order with their depth: each block in arrival order, and after an rlm() child's block the blocks of the
 * calls that child made (at any depth). A block whose child has no row yet stands at the top level.
 */
export function orderedBlocks(blocks: readonly Block[]): { block: Block; depth: number }[] {
  const out: { block: Block; depth: number }[] = [];
  const seen = new Set<Block>();
  const known = new Set(blocks.map(childOf).filter((c): c is number => c !== null));
  const visit = (block: Block, depth: number) => {
    if (seen.has(block)) return;
    seen.add(block);
    out.push({ block, depth });
    const child = childOf(block);
    if (child !== null) for (const b of blocks) if (b.child === child) visit(b, depth + 1);
  };
  for (const b of blocks) if (b.child === null || !known.has(b.child)) visit(b, 0);
  return out;
}

export function panelItems(blocks: readonly Block[], state: PanelState): PanelItem[] {
  const items: PanelItem[] = [];
  let hiddenBelow = Infinity; // a collapsed child hides the blocks nested under it
  for (const { block, depth } of orderedBlocks(blocks)) {
    if (depth > hiddenBelow) continue;
    hiddenBelow = Infinity;
    items.push({ kind: "block", block, depth });
    if (isOpen(block, state)) for (const row of block.rows) items.push({ kind: "row", block, row, depth });
    else if (childOf(block) !== null) hiddenBelow = depth;
  }
  return items;
}

/** Every row, in panel order, for the sub-call view's Left/Right. */
export function allRows(blocks: readonly Block[]): SubcallRow[] {
  return orderedBlocks(blocks).flatMap(({ block }) => block.rows);
}

/** The block a row is in. */
export function blockOfRow(blocks: readonly Block[], key: string): Block | undefined {
  return blocks.find((b) => b.rows.some((r) => r.key === key));
}

/** The cell code a row's "Issued by" line reads: the root's cells, or those of the rlm() child that made the call. */
export function rowCellCode(blocks: readonly Block[], row: SubcallRow, rootCode: Record<number, string>): Record<number, string> {
  if (row.origin.child === undefined) return rootCode;
  const code: Record<number, string> = {};
  for (const b of blocks) {
    for (const r of b.rows) {
      if (r.child?.id !== row.origin.child) continue;
      for (const c of r.child.cells) if (c.code !== null) code[c.turn] = c.code;
    }
  }
  return code;
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

/** A row's status word; a child between its turns is still running. */
export function statusWord(row: SubcallRow): string {
  return row.child && row.status === "streaming" ? "running" : WORDS[row.status];
}

export function statusColor(theme: Theme, status: SubcallRow["status"]): string | undefined {
  return paint(theme, { queued: undefined, streaming: "cyan", done: "green", error: "red", rejected: "yellow" }[status]);
}

function dot(theme: Theme, row: SubcallRow, now: number): string {
  if (row.status === "streaming") return theme.spinner[Math.floor(now / 100) % theme.spinner.length]!;
  return row.status === "queued" ? theme.off : theme.on;
}

function rowLine(row: SubcallRow, depth: number, now: number, width: number, theme: Theme, selected: boolean): Line {
  const id = row.subcallId === null ? "#--" : `#${String(row.subcallId).padStart(2, "0")}`;
  const word = statusWord(row).padEnd(9);
  let rest: string;
  if (row.status === "rejected") {
    rest = row.error ?? "refused";
  } else {
    const t = rowTokens(row);
    const s = rowSeconds(row, now);
    const tail = `${t.input} in ${t.output} out  ${s === null ? "" : formatDuration(s)}  `;
    // an rlm() child shows as `rlm` with its turn, then its task, where a call shows its prompt
    rest = row.child ? `rlm  turn ${row.child.turn}/${row.child.maxTurns}  ${tail}${row.child.task || row.prompt}` : `${tail}${row.prompt || ""}`;
  }
  const head = `${"  ".repeat(depth)}  ${dot(theme, row, now)} ${id} `;
  const tail = truncate(`  ${rest}`, Math.max(0, width - Bun.stringWidth(head) - 9), theme.more);
  return [
    span(head, { inverse: selected }),
    span(word.slice(0, 9), { color: statusColor(theme, row.status), inverse: selected }),
    span(tail, { inverse: selected, dim: row.status === "queued" }),
  ];
}

function blockLine(block: Block, depth: number, open: boolean, now: number, width: number, theme: Theme, selected: boolean): Line {
  const finished = blockFinished(block);
  const rejected = block.rows.find((r) => r.status === "rejected");
  const child = block.rows.find((r) => r.child !== null);
  const where = `turn ${block.origin.turn} line ${block.origin.line ?? "?"}`;
  const expands = finished && !open ? "  (Enter expands)" : "";
  let text: string;
  if (rejected) {
    text = `batch ${block.id}  ${block.size} prompt${block.size === 1 ? "" : "s"}  rejected: ${rejected.error ?? "refused"}`;
  } else if (child?.child) {
    const c = child.child;
    const secs = finished ? `  ${formatDuration(child.seconds ?? 0)}` : "";
    text = `rlm${c.id}  turn ${c.turn}/${c.maxTurns}  ${statusWord(child)}  ${where}${secs}${expands}`;
  } else {
    const done = block.rows.filter((r) => r.status === "done").length;
    const errs = block.rows.filter((r) => r.status === "error").length;
    const secs = finished ? Math.max(0, ...block.rows.map((r) => r.seconds ?? 0)) : null;
    text = `batch ${block.id}  ${block.size} call${block.size === 1 ? "" : "s"}  ${done}/${block.size} done${errs ? `, ${errs} err` : ""}  ${where}${secs !== null ? `  ${formatDuration(secs)}` : ""}${expands}`;
  }
  // a block of calls an rlm() child made: indented under it, and named for it
  if (block.child !== null) text = `${theme.nest} rlm${block.child}  ${text}`;
  const mark = finished ? theme.on : theme.spinner[Math.floor(now / 100) % theme.spinner.length]!;
  const color = rejected ? "yellow" : block.rows.some((r) => r.status === "error") ? "red" : finished ? "green" : "cyan";
  const indent = "  ".repeat(depth);
  return [
    span(`${indent}${mark} `, { color: paint(theme, color), inverse: selected }),
    span(truncate(text, Math.max(0, width - 2 - indent.length), theme.more), { bold: !finished, inverse: selected }),
  ];
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
    lines.push(item.kind === "block" ? blockLine(item.block, item.depth, isOpen(item.block, p.state), p.now, width, theme, sel) : rowLine(item.row, item.depth, p.now, width, theme, sel));
  }
  if (w.below > 0) lines.push([span(`  v ${w.below} more`, { dim: true })]);
  return lines;
}

/** Unfocused, the window starts at the newest top-level block's header, so a running child stays in view with its calls. */
function lastBlockStart(items: PanelItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === "block" && items[i]!.depth === 0) return i;
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
    (_input, key) => {
      const sel = Math.min(props.state.selected, Math.max(0, items.length - 1));
      if (key.upArrow) props.onState({ ...props.state, selected: Math.max(0, sel - 1) });
      else if (key.downArrow) props.onState({ ...props.state, selected: Math.min(items.length - 1, sel + 1) });
      else if (key.tab) props.onLeave();
      else if (key.return) {
        const item = items[sel];
        if (item?.kind === "row") props.onOpen(item.row.key);
        else if (item) props.onState({ ...props.state, selected: sel, open: { ...props.state.open, [panelKey(item.block)]: !isOpen(item.block, props.state) } });
      }
    },
    { isActive: props.focused },
  );
  const lines = panelLines({ ...props, theme });
  return <Lines lines={lines} height={props.height} width={props.width} />;
}
