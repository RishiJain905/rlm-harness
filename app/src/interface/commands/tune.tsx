// KV cache: none; the interface never touches the bytes sent to the model.
// /tune (v1 step 9, task 6; D-221, D-231, D-232): the status (on or off, the spend against the cap, the task in
// flight and the one waiting, the tuning model, tune.test and the library), and the estimate `/tune on` and `o`
// open first. Only the estimate's `y` turns tuning on, and there is no `y` when the profile is training-v4, no root
// model is picked, or both lines are over the cap. `/tune off` has no screen: App turns tuning off at once.

import { useInput } from "ink";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ModelRef, ProfileInfo } from "../../protocol.ts";
import { estimateOnline, tuningModel, type OnlineEstimate, type OnlineLine } from "../../tune/online.ts";
import { settingsRefs } from "../../session.ts";
import { wrapText } from "../format.ts";
import { paint, span, useTheme, type Line } from "../theme.ts";
import { Frame } from "./common.tsx";
import type { ScreenProps } from "./index.ts";

const usd = (x: number | null) => (x === null ? "unpriced" : `$${x.toFixed(2)}`);
const pct = (x: number | null) => (x === null ? "?" : `${Math.round(x * 100)}%`);
const ref = (r: ModelRef | null | undefined) => (r ? `${r.provider}/${r.model}` : "none");

/** One estimate line: `read  $0.68 a task  (3 runs $0.60, 88% · 4 sessions $0.08, 12%)  the cap covers 1`. */
export function estimateLine(l: OnlineLine): string {
  const covers = l.covers === null ? "the cap's cover is unknown" : l.covers === Infinity ? "the cap covers any number" : `the cap covers ${l.covers}`;
  const parts = `${l.runs.count} runs ${usd(l.runs.usd)}, ${pct(l.runs_share)} · ${l.sessions.count} sessions ${usd(l.sessions.usd)}, ${pct(l.sessions_share)}`;
  return `${l.mode.padEnd(5)} ${usd(l.total_usd)} a task  (${parts})  ${l.over_cap ? "OVER THE CAP" : covers}`;
}

/** What the estimate says when there is no `y`: why, and how to change the profile or raise tune.max_usd in /settings. */
export function blockedHint(e: OnlineEstimate): string | null {
  switch (e.blocked) {
    case "training-v4":
      return "training-v4 is never tuned, so there is no y. Change the profile with /tuned, or `profile` in /settings, then /tune on.";
    case "no_root":
      return "No root model is picked, so there is no y. /model picks one.";
    case "over_cap":
      return `Both lines are over the $${e.cap_usd.toFixed(2)} cap, so there is no y. Raise tune.max_usd in /settings, or change the profile, then /tune on.`;
    default:
      return null;
  }
}

/** The three facts the estimate says before any yes (spec task 6). */
export function estimateFacts(e: OnlineEstimate): string[] {
  const sessions = e.library ? 4 : 3;
  return [
    `Your own run is the reference, so a task costs up to 3 runs on the root model (${ref(e.root)}, sub ${ref(e.sub)}) plus ${sessions} sessions${e.library ? "" : " (the library is off)"} on the tuning model (${ref(e.tuning)}); the runs are most of it.`,
    "Tuning runs in the background after each new conversation's first answer. Its runs never ask, so anything that would ask is denied.",
    "Before each such question in repo mode, a snapshot of the folder is taken, uncommitted and untracked files included, without changing the folder.",
  ];
}

export function TuneScreen(props: ScreenProps) {
  const theme = useTheme();
  const { deps, tune } = props;
  useSyncExternalStore(
    (fn) => tune.subscribe(fn),
    () => tune.version,
  );
  const settings = deps.session.settings;
  const [view, setView] = useState<"status" | "estimate">(props.arg === "on" && !settings.tune.enabled ? "estimate" : "status");
  const [line, setLine] = useState<{ text: string; tone: "info" | "warn" } | null>(props.arg === "on" && settings.tune.enabled ? { text: "Tuning is already on.", tone: "info" } : null);
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let live = true;
    deps.session.info().then(
      (info) => live && setProfiles(info.profiles),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [deps.session]);
  // reads the run logs only: no run, no gateway call, nothing written
  const estimate = useMemo(
    () => (view === "estimate" ? estimateOnline({ home: deps.home, settings, catalog: deps.catalog, ...(profiles ? { profiles } : {}) }) : null),
    [view, deps.home, deps.catalog, settings, profiles],
  );

  useInput(
    (input, key) => {
      if (working) return;
      if (view === "estimate") {
        if (key.escape || input === "n") {
          setView("status");
          return;
        }
        if (input === "y" && estimate !== null && estimate.blocked === null) {
          setWorking(true);
          void tune.turnOn().then(
            () => {
              props.store.note(`Tuning is on: each new conversation's first answer is tuned in the background, up to $${deps.session.settings.tune.max_usd.toFixed(2)} in all. /tune off stops it.`, "info");
              props.close();
            },
            (err: unknown) => {
              setWorking(false);
              setLine({ text: `Could not turn tuning on: ${err instanceof Error ? err.message : String(err)}`, tone: "warn" });
            },
          );
        }
        return;
      }
      if (key.escape) return props.close();
      if (input === "o") {
        if (!tune.enabled) {
          setLine(null);
          setView("estimate");
          return;
        }
        setWorking(true);
        void tune.turnOff().then((text) => {
          setWorking(false);
          setLine({ text, tone: "info" });
          props.store.note(text, "info");
        });
      }
    },
    { isActive: props.active },
  );

  const w = props.width;
  const wrap = (text: string, style: { dim?: boolean; color?: string; bold?: boolean } = {}, indent = ""): Line[] =>
    wrapText(text, Math.max(10, w - indent.length)).map((l) => [span(`${indent}${l}`, style)]);
  const body: Line[] = [];
  if (view === "estimate" && estimate !== null) {
    body.push([span("Before tuning turns on: the estimate per task", { bold: true })], []);
    body.push([span(`  ${estimateLine(estimate.read)}`)], [span(`  ${estimateLine(estimate.repo)}`)]);
    body.push(...wrap(`The cap, tune.max_usd: $${estimate.cap_usd.toFixed(2)}, counting every /tune run and session from now on. When it is reached, tuning turns itself off.`, { dim: true }, "  "));
    if (estimate.unpriced.length > 0) body.push(...wrap(`Unpriced (no price in the catalog): ${estimate.unpriced.join(", ")}.`, { color: paint(theme, "yellow") }, "  "));
    body.push([]);
    for (const f of estimateFacts(estimate)) body.push(...wrap(f, {}, "  "));
    for (const warning of estimate.warnings) body.push([], ...wrap(`Warning: ${warning}.`, { color: paint(theme, "yellow") }, "  "));
    const hint = blockedHint(estimate);
    if (hint !== null) body.push([], ...wrap(hint, { color: paint(theme, "red") }, "  "));
  } else {
    const f = tune.figures();
    const on = tune.enabled;
    const root = settingsRefs(settings).root;
    const tuning = tuningModel(settings, root);
    body.push([span("Tuning: ", { bold: true }), span(on ? "on" : "off", { bold: true, color: paint(theme, on ? "green" : "yellow") })]);
    body.push([span(`  ${on ? "Spent since /tune on" : "Spent since the last /tune on"}: $${f.spent_usd.toFixed(2)} of the $${f.cap_usd.toFixed(2)} cap (tune.max_usd)`)]);
    body.push([span(`  In flight: ${f.running ? `${f.running.id} (${f.running.mode})${f.running.stage ? `, stage ${f.running.stage}` : ""}` : "none"}`)]);
    body.push([span(`  Waiting: ${f.waiting ? `${f.waiting.id} (${f.waiting.mode})` : "none"}`)]);
    body.push([span(`  Tuning model: ${settings.tune.model === "" ? `same as root (${ref(tuning)})` : settings.tune.model}`)]);
    body.push([span(`  tune.test: ${settings.tune.test === "" ? "none" : settings.tune.test}`)]);
    body.push([span(`  Library: ${settings.tune.library ? "on" : "off"}`)]);
    const pending = tune.pendingSwitch();
    body.push([span(`  Active harness: ${settings.profile}${pending ? `; ${pending} becomes active when this conversation ends` : ""}. /tuned picks another.`, { dim: true })]);
    body.push([]);
    body.push(...wrap(on ? "Each new conversation's first answer is tuned in the background, one task at a time." : "Tuning is off: nothing is tuned or spent. A tuned harness stays active while it is off.", { dim: true }, "  "));
  }
  if (line !== null) body.push([], ...wrap(line.text, line.tone === "warn" ? { color: paint(theme, "yellow") } : {}, "  "));
  const blocked = estimate !== null && estimate.blocked !== null;
  const hint =
    working ? "Working..." : view === "estimate" ? (blocked ? "n or Esc goes back" : "y turns tuning on  n or Esc goes back") : tune.enabled ? "o turns tuning off  Esc closes" : "o turns tuning on (the cost first)  Esc closes";
  return <Frame title="/tune" hint={hint} body={body} width={w} height={props.height} />;
}
