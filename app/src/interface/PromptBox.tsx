// KV cache: none; the interface never touches the bytes sent to the model.
// The single-line prompt: a cursor, this session's history (Up/Down, never written to disk), the
// slash menu while the line starts with `/`, the file menu while the line ends in an `@` mention,
// and Tab completion of `/command` and `@path`.
// A paste never submits: its newlines become spaces.

import { Box, useInput, usePaste } from "ink";
import { useState } from "react";
import { completePath, mentionText, mentionToken, namesFile } from "./mentions.ts";
import { graphemeSpans, nextGrapheme, prevGrapheme, sanitize, snapToGrapheme, truncate } from "./format.ts";
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
  /** The file menu's paths for the `@` mention at the end of the line, best first; `menu` wins if both are given. */
  files: string[];
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
  // the cursor sits between graphemes (a user-perceived character: an emoji, a letter and its accent), never inside one
  const at = snapToGrapheme(value, Math.min(cursor, value.length));
  const menuOpen = props.menu.length > 0;
  const files = menuOpen ? [] : props.files;
  const filesOpen = files.length > 0;
  const listLength = menuOpen ? props.menu.length : files.length;
  const sel = Math.min(menuSel, Math.max(0, listLength - 1));

  const set = (v: string, c = v.length) => {
    props.onChange(v);
    setCursor(c);
    setMenuSel(0);
  };
  const insert = (text: string) => {
    const t = cleanInput(text);
    if (t) set(value.slice(0, at) + t + value.slice(at), at + t.length);
  };

  /** The file under the selection replaces the mention, and a space ends it, which closes the menu. */
  const pickFile = () => {
    const token = mentionToken(value);
    if (token) set(`${value.slice(0, token.start + 1)}${mentionText(files[sel]!)} `);
  };

  const complete = () => {
    if (value === "") return props.onFocusPanel();
    if (menuOpen) return set(`/${props.menu[sel]!.name}`);
    if (filesOpen) return pickFile();
    const token = mentionToken(value);
    if (!token) return;
    const { start, typed } = token;
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
        // Enter picks the file under the selection, unless the mention already names a file and the pick was not moved
        else if (filesOpen && (sel > 0 || !namesFile(mentionToken(value)?.typed ?? "", props.cwd))) return pickFile();
        else props.onSubmit(value);
        setHist(null);
        return;
      }
      if (key.tab) return complete();
      if (key.leftArrow) return setCursor(prevGrapheme(value, at));
      if (key.rightArrow) return setCursor(nextGrapheme(value, at));
      if (key.backspace || key.delete) {
        if (at > 0) {
          const from = prevGrapheme(value, at);
          set(value.slice(0, from) + value.slice(at), from);
        }
        return;
      }
      if (key.upArrow || key.downArrow) {
        // the menu takes the arrows, except while stepping through history (an entry can start with /)
        if ((menuOpen || filesOpen) && hist === null) return setMenuSel((s) => (Math.min(s, listLength - 1) + (key.upArrow ? listLength - 1 : 1)) % listLength);
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

  // the menu, above the box; the file menu scrolls to keep the selection in view
  const top = Math.max(0, sel - props.menuHeight + 1);
  const menuLines: Line[] = filesOpen
    ? files.slice(top, top + props.menuHeight).map((path, i) => {
        const cut = path.lastIndexOf("/") + 1;
        const at = top + i === sel;
        const shown = truncate(`  @${path}`, props.width, theme.more);
        const folderEnd = Math.min(shown.length, 3 + cut);
        return [
          span(shown.slice(0, folderEnd), { dim: !at, inverse: at }),
          span(shown.slice(folderEnd).padEnd(Math.max(0, props.width - folderEnd)), { bold: true, inverse: at, color: paint(theme, "cyan") }),
        ];
      })
    : props.menu.slice(0, props.menuHeight).map((m, i) => [
        span(`  /${m.name}`.padEnd(16), { bold: true, inverse: i === sel, color: paint(theme, "cyan") }),
        span(truncate(m.summary, Math.max(0, props.width - 16), theme.more), { dim: i !== sel, inverse: i === sel }),
      ]);

  // the line: "> " then a window of the text that keeps the cursor in view
  const inner = Math.max(1, props.width - 4 - 2);
  let line: Line;
  if (value === "") {
    line = [span("> ", { bold: true }), ...(props.active && !props.disabled ? [span(" ", { inverse: true })] : []), span(truncate(props.hint, inner - 1, theme.more), { dim: true })];
  } else {
    // whole graphemes only: up to inner - 1 columns before the cursor, the cursor's own, and what fits after
    const segs = graphemeSpans(value);
    const ci = segs.findIndex((s) => s.start >= at);
    const cursorAt = ci < 0 ? segs.length : ci;
    const offset = (i: number) => segs[i]?.start ?? value.length;
    let before = 0;
    let first = cursorAt;
    while (first > 0 && before + Bun.stringWidth(segs[first - 1]!.text) <= inner - 1) before += Bun.stringWidth(segs[--first]!.text);
    const under = segs[cursorAt]?.text ?? " ";
    let room = inner - before - Math.max(1, Bun.stringWidth(under));
    let last = cursorAt + 1;
    while (last < segs.length && Bun.stringWidth(segs[last]!.text) <= room) room -= Bun.stringWidth(segs[last++]!.text);
    const cursorOn = props.active && !props.disabled;
    line = [
      span("> ", { bold: true }),
      span(value.slice(offset(first), offset(cursorAt)), { dim: props.disabled }),
      ...(cursorOn ? [span(under, { inverse: true })] : [span(segs[cursorAt]?.text ?? "")]),
      span(value.slice(offset(cursorAt + 1), offset(last)), { dim: props.disabled }),
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
