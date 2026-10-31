// KV cache: none; the interface never touches the bytes sent to the model.
// The single-line prompt: a cursor, this session's history (Up/Down, never written to disk), the
// slash menu while the line starts with `/`, and Tab completion of `/command` and `@path`.
// A paste never submits: its newlines become spaces.

import { Box, useInput, usePaste } from "ink";
import { useState } from "react";
import { completePath } from "./mentions.ts";
import { sanitize, truncate } from "./format.ts";
import { Lines } from "./Lines.tsx";
import { paint, span, useTheme, type Line } from "./theme.ts";

export const HISTORY_MAX = 100;

export interface MenuItem {
  name: string;
  summary: string;
}

/** Typed or pasted text as one line: control characters dropped, line breaks as spaces. */
export function cleanInput(text: string): string {
  return sanitize(text.replace(/\r\n|\r|\n/g, " ")).replace(/\t/g, " ");
}

/** Where the `@` token under completion starts, or -1. */
function mentionStart(value: string): number {
  const m = /(^|\s)@("[^"]*|\S*)$/.exec(value);
  return m ? m.index + m[1]!.length : -1;
}

function commonPrefix(items: string[]): string {
  let p = items[0] ?? "";
  for (const s of items) while (!s.startsWith(p)) p = p.slice(0, -1);
  return p;
}

export function PromptBox(props: {
  value: string;
  onChange(v: string): void;
  onSubmit(v: string): void;
  disabled: boolean;
  hint: string;
  active: boolean;
  width: number;
  menu: MenuItem[];
  menuHeight: number;
  cwd: string;
  history: string[];
  onFocusPanel(): void;
}) {
  const theme = useTheme();
  const { value } = props;
  const [cursor, setCursor] = useState(value.length);
  const [menuSel, setMenuSel] = useState(0);
  const [hist, setHist] = useState<{ index: number; draft: string } | null>(null);
  const at = Math.min(cursor, value.length);
  const menuOpen = props.menu.length > 0;
  const sel = Math.min(menuSel, Math.max(0, props.menu.length - 1));

  const set = (v: string, c = v.length) => {
    props.onChange(v);
    setCursor(c);
    setMenuSel(0);
  };
  const insert = (text: string) => {
    const t = cleanInput(text);
    if (t) set(value.slice(0, at) + t + value.slice(at), at + t.length);
  };

  const complete = () => {
    if (value === "") return props.onFocusPanel();
    if (menuOpen) return set(`/${props.menu[sel]!.name}`);
    const start = mentionStart(value);
    if (start < 0) return;
    const typed = value.slice(start + 1);
    const found = completePath(typed, props.cwd);
    if (found.length === 0) return;
    // completePath quotes a path with spaces itself
    const next = found.length === 1 ? found[0]! : commonPrefix(found);
    if (found.length > 1 && next.length <= typed.length) return;
    set(`${value.slice(0, start + 1)}${next}`);
  };

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === "c") || key.pageUp || key.pageDown || key.end) return; // App's keys
      if (key.return) {
        if (menuOpen && !props.menu.some((m) => `/${m.name}` === value.trim())) props.onSubmit(`/${props.menu[sel]!.name}`);
        else props.onSubmit(value);
        setHist(null);
        return;
      }
      if (key.tab) return complete();
      if (key.leftArrow) return setCursor(Math.max(0, at - 1));
      if (key.rightArrow) return setCursor(Math.min(value.length, at + 1));
      if (key.backspace || key.delete) {
        if (at > 0) set(value.slice(0, at - 1) + value.slice(at), at - 1);
        return;
      }
      if (key.upArrow || key.downArrow) {
        // the menu takes the arrows, except while stepping through history (an entry can start with /)
        if (menuOpen && hist === null) return setMenuSel((s) => (s + (key.upArrow ? props.menu.length - 1 : 1)) % props.menu.length);
        const h = props.history;
        if (h.length === 0) return;
        if (key.upArrow) {
          const index = hist === null ? h.length - 1 : Math.max(0, hist.index - 1);
          setHist({ index, draft: hist?.draft ?? value });
          set(h[index]!);
        } else if (hist !== null) {
          if (hist.index + 1 >= h.length) {
            setHist(null);
            set(hist.draft);
          } else {
            setHist({ ...hist, index: hist.index + 1 });
            set(h[hist.index + 1]!);
          }
        }
        return;
      }
      if (key.ctrl) {
        if (input === "u") set(value.slice(at), 0);
        else if (input === "a") setCursor(0);
        else if (input === "e") setCursor(value.length);
        return; // other control keys (Ctrl+V arrives as \x16) are ignored
      }
      if (key.meta) return;
      insert(input);
    },
    { isActive: props.active && !props.disabled },
  );
  usePaste((text) => insert(text), { isActive: props.active && !props.disabled });

  // the menu, above the box
  const menuLines: Line[] = props.menu.slice(0, props.menuHeight).map((m, i) => [
    span(`  /${m.name}`.padEnd(16), { bold: true, inverse: i === sel, color: paint(theme, "cyan") }),
    span(truncate(m.summary, Math.max(0, props.width - 16), theme.more), { dim: i !== sel, inverse: i === sel }),
  ]);

  // the line: "> " then a window of the text that keeps the cursor in view
  const inner = Math.max(1, props.width - 4 - 2);
  let line: Line;
  if (value === "") {
    line = [span("> ", { bold: true }), ...(props.active && !props.disabled ? [span(" ", { inverse: true })] : []), span(truncate(props.hint, inner - 1, theme.more), { dim: true })];
  } else {
    const start = Math.max(0, at - inner + 1);
    const shown = value.slice(start, start + inner);
    const c = at - start;
    const cursorOn = props.active && !props.disabled;
    line = [
      span("> ", { bold: true }),
      span(shown.slice(0, c), { dim: props.disabled }),
      ...(cursorOn ? [span(shown[c] ?? " ", { inverse: true })] : [span(shown[c] ?? "")]),
      span(shown.slice(c + 1), { dim: props.disabled }),
    ];
  }
  return (
    <Box flexDirection="column" width={props.width}>
      {props.menuHeight > 0 ? <Lines lines={menuLines} height={props.menuHeight} width={props.width} /> : null}
      <Box borderStyle={theme.border} borderColor={paint(theme, props.active && !props.disabled ? "cyan" : "gray")} paddingX={1} height={3} width={props.width}>
        <Lines lines={[line]} height={1} width={props.width - 4} />
      </Box>
    </Box>
  );
}
