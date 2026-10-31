// KV cache: none
// What `rlmh run` and `rlmh batch` print (architecture §7.8, D-27): `--json` lines for machines,
// or short progress lines for people. Each line is built whole and written with one `write`.

import type { Bus } from "../bus.ts";
import type { AppEvents } from "../gateway/gateway.ts";
import type {
  ModelRef,
  RunCellParams,
  RunFinishedParams,
  RunPermissionParams,
  RunReplyParams,
  RunStartedParams,
  RunSubcallParams,
} from "../protocol.ts";

export interface LineSink {
  write(chunk: string): void;
}

const PLAIN_MAX_LINES = 20;

/** One `--json` line: `{type, ...body}` and a newline. */
export function jsonLine(type: string, body: object): string {
  return `${JSON.stringify({ type, ...body })}\n`;
}

/** Every run.* event as `{type: <method>, ...params}`, and one `gateway.call` line per finished model call. */
export function attachJson(bus: Bus<AppEvents>, out: LineSink): () => void {
  const calls = new Map<string, AppEvents["call.start"]>();
  const offs = [
    bus.on("engine.event", (e) => {
      // model.cancel is an order to the gateway, not run state; the session forwards only run.*
      if (e.method.startsWith("run.")) out.write(jsonLine(e.method, e.params));
    }),
    bus.on("call.start", (c) => {
      calls.set(c.call_id, c);
    }),
    bus.on("call.end", (c) => {
      const start = calls.get(c.call_id);
      calls.delete(c.call_id);
      out.write(
        jsonLine("gateway.call", {
          run_id: c.run_id,
          role: start?.role ?? null,
          subcall_id: start?.subcall_id ?? null,
          model: start?.model ?? null,
          usage: c.usage,
          seconds: c.seconds,
          error: c.error ?? null,
        }),
      );
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/** Progress for people. A run with a tag (a batch task id) gets `[tag] ` before each line. */
export function attachPlain(bus: Bus<AppEvents>, out: LineSink): () => void {
  const tags = new Map<string, string>();
  const say = (runId: string, lines: string[]) => {
    const tag = tags.get(runId);
    const prefix = tag === undefined ? "" : `[${tag}] `;
    out.write(lines.map((l) => `${prefix}${l}\n`).join(""));
  };
  return bus.on("engine.event", ({ method, params }) => {
    switch (method) {
      case "run.started": {
        const p = params as RunStartedParams;
        if (p.tag !== null) tags.set(p.run_id, p.tag);
        say(p.run_id, [
          `run ${p.run_id} started: ${p.mode} mode, profile ${p.profile}, root ${refText(p.root)}, sub ${refText(p.sub)}, ` +
            `${p.call_format} calls, ${p.input.chars.toLocaleString("en-US")} input chars`,
          `log: ${p.log_path}`,
        ]);
        break;
      }
      case "run.reply": {
        const p = params as RunReplyParams;
        say(p.run_id, [`turn ${p.turn}: reply, ${p.usage.output_tokens} tokens, ${secs(p.seconds)}`]);
        break;
      }
      case "run.cell": {
        const p = params as RunCellParams;
        say(p.run_id, [`turn ${p.turn}: cell ${secs(p.seconds)}`, ...indent(p.output), ...indent(p.error ?? "")]);
        break;
      }
      case "run.subcall": {
        const p = params as RunSubcallParams;
        if (p.status === "sent") break;
        const id = p.subcall_id === null ? "" : ` #${p.subcall_id}`;
        const how = p.status === "done" ? `done, ${secs(p.seconds ?? 0)}` : `${p.status}: ${p.error ?? ""}`;
        say(p.run_id, [`turn ${p.origin.turn}: sub-call${id} ${how}`]);
        break;
      }
      case "run.permission": {
        const p = params as RunPermissionParams;
        const how = [p.allowed ? "allowed" : "denied", p.asked ? "asked" : "not asked", ...(p.remembered ? ["remembered"] : [])];
        say(p.run_id, [`turn ${p.turn}: permission ${p.kind} ${p.detail}: ${how.join(", ")}`]);
        break;
      }
      case "run.finished": {
        const p = params as RunFinishedParams;
        const lines = [
          `run finished: ${p.submitted ? "submitted" : "not submitted"}, ${p.turns} turns, ${p.subcalls} sub-calls, ` +
            `$${p.cost_usd.toFixed(4)}, ${secs(p.wall_s)}`,
        ];
        if (p.infra_error !== null) lines.push(`infra error: ${p.infra_error}`);
        say(p.run_id, lines);
        tags.delete(p.run_id);
        break;
      }
      // run.budget and sub-calls at `sent` stay silent
    }
  });
}

function refText(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}${ref.thinking === null ? "" : ` (thinking ${ref.thinking})`}`;
}

function secs(s: number): string {
  return `${s.toFixed(1)} s`;
}

/** Text indented 4 spaces, at most PLAIN_MAX_LINES lines. */
function indent(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, PLAIN_MAX_LINES).map((l) => `    ${l}`);
  if (lines.length > PLAIN_MAX_LINES) shown.push(`    … ${lines.length - PLAIN_MAX_LINES} more lines`);
  return shown;
}
