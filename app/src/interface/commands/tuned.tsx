// KV cache: none; the interface never touches the bytes sent to the model.
// /tuned (v1 step 9, task 7; D-231): the picker of the active harness. The built-in `default` first, then every
// `tuned-*` profile engine.info lists, newest first, each with its date, base and number of changes from
// `<home>/tune/tuned.jsonl` ("—" when it has no line). Enter sets `profile` through applySetting; with a
// conversation open it closes it, as a profile change does (D-202), and a pending switch from a tune is dropped.
// It never spends and starts no run.

import { useInput } from "ink";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useEffect, useState } from "react";
import { tuneDir } from "../../paths.ts";
import { applySetting } from "../store.ts";
import { paint, span, useTheme, type Line } from "../theme.ts";
import { fit, Frame, listLines } from "./common.tsx";
import type { ScreenProps } from "./index.ts";

export interface TunedLine {
  name: string;
  base: string;
  changed: string[];
  at: string;
}

/** tuned.jsonl's lines by profile name (the last line for a name wins); torn lines are skipped. */
export function readTunedLines(home: string): Map<string, TunedLine> {
  const out = new Map<string, TunedLine>();
  let text: string;
  try {
    text = readFileSync(join(tuneDir(home), "tuned.jsonl"), "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const j = JSON.parse(raw);
      if (typeof j?.name !== "string") continue;
      out.set(j.name, { name: j.name, base: typeof j.base === "string" ? j.base : "—", changed: Array.isArray(j.changed) ? j.changed.map(String) : [], at: typeof j.at === "string" ? j.at : "" });
    } catch {
      // torn
    }
  }
  return out;
}

/** `default`, then the `tuned-*` names newest first (their stamps sort; `-2` after its stamp is newer). */
export function tunedChoices(names: string[]): string[] {
  const tuned = names.filter((n) => n.startsWith("tuned-")).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return ["default", ...tuned];
}

/** `2026-11-05 14:02` from an ISO time, in local time; "—" when there is none. */
function when(at: string | undefined): string {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function TunedScreen(props: ScreenProps) {
  const theme = useTheme();
  const { deps } = props;
  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [lines] = useState(() => readTunedLines(deps.home));
  const [, redraw] = useState(0);
  useEffect(() => {
    let live = true;
    deps.session.info().then(
      (info) => {
        if (!live) return;
        const choices = tunedChoices(info.profiles.map((p) => p.name));
        setNames(choices);
        setSel(Math.max(0, choices.indexOf(deps.session.settings.profile)));
      },
      (err: unknown) => live && setError(`Could not list the profiles: ${err instanceof Error ? err.message : String(err)}`),
    );
    return () => {
      live = false;
    };
  }, [deps.session]);

  const active = deps.session.settings.profile;
  const open = props.store.conversation()?.open ?? false;
  useInput(
    (_input, key) => {
      if (key.escape) return props.close();
      if (names === null || names.length === 0) return;
      if (key.upArrow) return setSel((s) => Math.max(0, s - 1));
      if (key.downArrow) return setSel((s) => Math.min(names.length - 1, s + 1));
      if (key.return) {
        const pick = names[sel]!;
        const dropped = props.tune.dropPending();
        if (pick === active) {
          setMessage(`${pick} is already the active harness.${dropped ? ` ${dropped}` : ""}`);
          return;
        }
        try {
          applySetting(deps, "profile", pick);
        } catch (err) {
          setMessage(err instanceof Error ? err.message : String(err));
          return;
        }
        const note = `The active harness is now ${pick}.${dropped ? ` ${dropped}` : ""}`;
        props.store.note(note, "info");
        setMessage(note);
        redraw((n) => n + 1);
        if (open) void props.closeConversation();
      }
    },
    { isActive: props.active },
  );

  const w = props.width;
  const body: Line[] = [];
  if (error !== null) body.push([span(fit(error, w, theme), { color: paint(theme, "red") })]);
  else if (names === null) body.push([span("Reading the profiles...", { dim: true })]);
  else {
    if (!names.includes(active)) body.push([span(fit(`The active harness is ${active}, which is neither default nor a tuned one.`, w, theme), { color: paint(theme, "yellow") })]);
    const width = Math.max(...names.map((n) => n.length), 7);
    const items: Line[] = names.map((n) => {
      const mark = n === active ? "*" : " ";
      if (n === "default") return [span(fit(`${mark} ${n.padEnd(width)}  built-in`, w, theme))];
      const l = lines.get(n);
      const detail = l ? `${when(l.at)}  base ${l.base}  ${l.changed.length} change${l.changed.length === 1 ? "" : "s"}` : "—  base —  —";
      return [span(fit(`${mark} ${n.padEnd(width)}  ${detail}`, w, theme))];
    });
    body.push(...listLines(items, sel, Math.max(1, props.height - 2 - body.length - 3)));
    body.push([span(fit("  * is the active harness. It stays active across sessions, with tuning on or off.", w, theme), { dim: true })]);
    if (open) body.push([span(fit("  Switching closes the open conversation; the next question starts a new one.", w, theme), { color: paint(theme, "yellow") })]);
  }
  if (message !== null) body.push([span(fit(`  ${message}`, w, theme))]);
  return <Frame title="/tuned" hint="Enter makes it active  Up/Down  Esc closes" body={body} width={w} height={props.height} />;
}
