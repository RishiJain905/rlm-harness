// KV cache: none
// The tuner's stage prompts (v1 step 6, D-206): one file per part in prompts/, adapted from harness2's
// core/prompts.py and core/context.py at 6868817 with their Apache-2.0 notice kept. Each file is imported as
// text, so the binary carries it; its leading notice comment is stripped, its `<!-- part: name -->` markers
// split it into named parts, and a stage's parts are joined in harness2's order with `_tidy`'s rule.

import answerFree from "./prompts/answer-free.md" with { type: "text" };
import compose from "./prompts/compose.md" with { type: "text" };
import dom from "./prompts/dom.md" with { type: "text" };
import evidenceBoundary from "./prompts/evidence-boundary.md" with { type: "text" };
import generalize from "./prompts/generalize.md" with { type: "text" };
import inv from "./prompts/inv.md" with { type: "text" };
import keepBase from "./prompts/keep-base.md" with { type: "text" };
import mission from "./prompts/mission.md" with { type: "text" };
import propose from "./prompts/propose.md" with { type: "text" };
import reflect from "./prompts/reflect.md" with { type: "text" };
import submit from "./prompts/submit.md" with { type: "text" };
import surfaceGated from "./prompts/surface-gated.md" with { type: "text" };
import surface from "./prompts/surface.md" with { type: "text" };
import work from "./prompts/work.md" with { type: "text" };
import type { Stage } from "./evidence.ts";

/** Every prompt file, by name, as committed (notice included); tests read these. */
export const PROMPT_FILES: Record<string, string> = {
  "answer-free.md": answerFree,
  "compose.md": compose,
  "dom.md": dom,
  "evidence-boundary.md": evidenceBoundary,
  "generalize.md": generalize,
  "inv.md": inv,
  "keep-base.md": keepBase,
  "mission.md": mission,
  "propose.md": propose,
  "reflect.md": reflect,
  "submit.md": submit,
  "surface-gated.md": surfaceGated,
  "surface.md": surface,
  "work.md": work,
};

const PART = /^<!-- part: ([a-z-]+) -->\n/gm;

/** A file's text without its leading notice comment, split at its part markers ("" is the text before the first). */
export function parts(file: string): Map<string, string> {
  const text = file.replace(/\r\n/g, "\n").replace(/^<!--[\s\S]*?-->\n/, "");
  const out = new Map<string, string>();
  const marks = [...text.matchAll(PART)];
  out.set("", (marks.length > 0 ? text.slice(0, marks[0]!.index) : text).trim());
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.index : text.length;
    out.set(m[1]!, text.slice(m.index! + m[0].length, end).trim());
  });
  return out;
}

const whole = (file: string) => parts(file).get("")!;
const part = (file: string, name: string) => {
  const p = parts(file).get(name);
  if (p === undefined) throw new Error(`prompt part ${name} is missing`);
  return p;
};

/** harness2's `_tidy`: collapse blank runs, strip, end with one newline. */
export function tidy(text: string): string {
  return `${text.replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export interface StageOpts {
  /** D-234: add surface-gated.md and the gated paths. */
  gated?: boolean;
  /** The evidence files relative to the evidence folder; default: the stage's usual layout. */
  layout?: string[];
}

const DEFAULT_LAYOUT: Record<Stage, string[]> = {
  inv: ["stage.md", "harness/profile.toml, harness/guidance.md, harness/system_prompt.md (and harness/skills/, harness/scripts/)", "tasks/<id>/task.md", "tasks/<id>/ref/trajectory.md, tasks/<id>/ref/deliverable.md", "history.md", "library/<domain>/INDEX.md and entries/"],
  dom: [],
  compose: ["stage.md", "harness/profile.toml, harness/guidance.md, harness/system_prompt.md (and harness/skills/, harness/scripts/)", "tasks/<id>/task.md", "tasks/<id>/ref/, tasks/<id>/inv/, tasks/<id>/dom/ (trajectory.md, deliverable.md)", "candidates/inv/, candidates/dom/ (diff.md, notes.md)", "history.md", "library/<domain>/INDEX.md and entries/"],
  reflect: ["stage.md", "harness/ (the harness the round started from)", "tasks/<id>/task.md", "tasks/<id>/ref/, inv/, dom/ and composed/ (trajectory.md, deliverable.md)", "candidates/inv/, candidates/dom/, candidates/composed/ (diff.md, notes.md)", "history.md", "library/<domain>/INDEX.md and entries/"],
};
DEFAULT_LAYOUT.dom = DEFAULT_LAYOUT.inv;

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([a-z_]+)\}\}/g, (m, name: string) => (name in vars ? vars[name]! : m));
}

/** The question of one session: the stage's job, then the mission's pointer to the evidence. */
export function stagePrompt(stage: Stage, round: number, o: StageOpts = {}): string {
  const gated = o.gated ?? false;
  const layout = (o.layout ?? DEFAULT_LAYOUT[stage]).map((l) => `    ${l}`).join("\n");
  const later = round >= 2;
  const surfaceText = [whole(surface), ...(gated ? [whole(surfaceGated)] : [])];
  const vars = {
    round: String(round),
    layout,
    toml_rule: stage === "dom" ? " -- as the DOM candidate, leave it empty: `{}`" : "",
    gated_paths: gated ? ", or `agents/<name>/AGENT.md` and `nudges.toml` under the gate" : "",
  };
  let job: string[];
  if (stage === "inv" || stage === "dom") {
    job = [
      part(propose, "frame"),
      whole(work),
      whole(stage === "inv" ? inv : dom),
      whole(generalize),
      [part(propose, "how"), ...(later ? [part(propose, "round")] : []), part(propose, "commit")].join("\n\n"),
      whole(answerFree),
      whole(evidenceBoundary),
      ...surfaceText,
      part(submit, "editor"),
    ];
  } else if (stage === "compose") {
    job = [
      part(compose, "frame"),
      whole(work),
      part(compose, "have"),
      part(compose, "weigh"),
      [part(compose, "job"), whole(keepBase), ...(later ? [part(compose, "round")] : [])].join("\n\n"),
      whole(answerFree),
      whole(evidenceBoundary),
      ...surfaceText,
      part(compose, "notes"),
      part(submit, "composer"),
    ];
  } else {
    job = [part(reflect, "frame"), whole(work), part(reflect, "body"), whole(answerFree), whole(evidenceBoundary), part(submit, "reflector")];
  }
  return tidy(fill([...job, whole(mission)].join("\n\n"), vars));
}
