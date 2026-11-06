// KV cache: none; the interface never touches the bytes sent to the model.
// /tune in the interactive app (v1 step 9, tasks 5 and 6; D-178, D-231): TuneControl owns the TuneQueue and
// everything App does around it. It takes the snapshot before a tuned repo question's run.start, watches the
// user's own runs on the bus and offers each first prompt at its run.finished, turns tuning on and off, turns
// TuneEvents into transcript notes, and makes a kept harness the active profile at once, or, when a conversation
// is open, once it ends, so tuning never closes a conversation under the user. Background tuning never touches
// the prompt box, the user's run or the approval queue: its runs are non-interactive.

import { message } from "../cli/run.ts";
import type { RunFinishedParams, RunStartedParams } from "../protocol.ts";
import type { StartRun } from "../session.ts";
import { offerProblem, takeSnapshot, taskFromRun, TuneQueue, writeOnline, spentSince, readOnline, type TuneEvent } from "../tune/online.ts";
import { pruneStale, type Snapshot } from "../tune/worktree.ts";
import { applySetting, isActive, type AppDeps, type RunStore, type TuneStatus } from "./store.ts";

/** How long quitting waits for the tune in flight to clean up its work copies before the engine is closed. */
export const QUIT_WAIT_MS = 5000;
/** How many of the user's own runs' run.started and run.finished are kept for a start() that resolves late. */
const SEEN_MAX = 8;

type Snap = { id: string; snapshot: Snapshot };

/** One of the user's runs that may be offered: its request, its snapshot (repo mode), and what the bus said of it. */
interface Tracked {
  request: StartRun;
  snap: Snap | null;
  runId: string | null;
  started: RunStartedParams | null;
}

export interface TrackHandle {
  /** session.start resolved with this run id. */
  resolved(runId: string): void;
  /** session.start rejected: the run never started, so its snapshot goes. */
  failed(): void;
}

/** The line for a kept harness's changes: "1 change" or "3 changes". */
const changes = (n: number) => `${n} change${n === 1 ? "" : "s"}`;

export class TuneControl {
  private queue: TuneQueue | null = null;
  /** A kept harness waiting for the open conversation to end, and the profile that was active when it was kept. */
  private pending: { name: string; expect: string } | null = null;
  private tracked: Tracked[] = [];
  private readonly seen = new Map<string, { started?: RunStartedParams; finished?: RunFinishedParams }>();
  /** App is closing a conversation itself (a new question, /clear): it applies the pending switch afterwards. */
  private holding = 0;
  private readonly listeners = new Set<() => void>();
  private readonly off: (() => void)[] = [];
  private disposed = false;
  /** Bumped on every change, for useSyncExternalStore. */
  version = 0;

  constructor(
    private readonly deps: AppDeps,
    private readonly store: RunStore,
  ) {
    this.off.push(deps.session.bus.on("engine.event", (e) => this.onEngine(e.method, e.params)));
  }

  // -- React --

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private bump(): void {
    this.version += 1;
    for (const fn of [...this.listeners]) fn();
  }

  // -- state --

  get enabled(): boolean {
    return this.deps.session.settings.tune.enabled;
  }

  /** The status line's and /tune's figures; null while tuning is off. */
  status(): TuneStatus | null {
    if (!this.enabled) return null;
    const q = this.ensureQueue().state();
    return { spent_usd: q.spent_usd, cap_usd: q.cap_usd, running: q.running, waiting: q.waiting };
  }

  /** What /tune's status shows when tuning is off too: the spend since the last /tune on and the cap. */
  figures(): TuneStatus {
    const s = this.status();
    if (s !== null) return s;
    const on = readOnline(this.deps.home);
    return { spent_usd: on === null ? 0 : spentSince(this.deps.home, on.on_since), cap_usd: this.deps.session.settings.tune.max_usd, running: null, waiting: null };
  }

  /** The name of the kept harness waiting for the open conversation to end, or null. */
  pendingSwitch(): string | null {
    return this.pending?.name ?? null;
  }

  private ensureQueue(): TuneQueue {
    this.queue ??= new TuneQueue(
      {
        home: this.deps.home,
        session: this.deps.session,
        settings: () => this.deps.session.settings,
        turnOff: () => void applySetting(this.deps, "tune.enabled", false),
      },
      (e) => this.onTuneEvent(e),
    );
    return this.queue;
  }

  // -- start-up, on, off, quit --

  /** At start-up: with tuning on, the leftovers of an earlier session go, and the queue sums the spend so far. */
  startup(): void {
    if (!this.enabled) return;
    this.ensureQueue();
    pruneStale(this.deps.home).catch(() => undefined);
    this.bump();
  }

  /** `/tune on`'s yes: tune.enabled = true (the only place that sets it), online.json, pruneStale, and the spend from $0. */
  async turnOn(): Promise<void> {
    applySetting(this.deps, "tune.enabled", true);
    writeOnline(this.deps.home);
    try {
      await pruneStale(this.deps.home);
    } catch {
      // a leftover that can't be removed now is tried again at the next start-up
    }
    this.ensureQueue().resync();
    this.bump();
  }

  /**
   * `/tune off`: tune.enabled = false, then the tune in flight is cancelled (it keeps nothing) and the waiting task
   * dropped. The line says what it cancelled; null when tuning was already off and nothing ran.
   */
  async turnOff(): Promise<string> {
    const was = this.enabled;
    if (was) applySetting(this.deps, "tune.enabled", false);
    this.bump();
    const r = this.queue ? await this.queue.cancel("off") : { cancelled: null, dropped: null };
    this.bump();
    if (!was && r.cancelled === null && r.dropped === null) return "Tuning is already off.";
    const what: string[] = [];
    if (r.cancelled !== null) what.push(`cancelled the tune of ${r.cancelled}`);
    if (r.dropped !== null) what.push(`dropped the waiting task ${r.dropped}`);
    return `Tuning is off${what.length > 0 ? `: ${what.join(" and ")}` : ""}. /tuned still picks the active harness.`;
  }

  /** Quitting: the pending switch applies, the tune in flight is cancelled and the waiting task dropped (waiting at most QUIT_WAIT_MS). */
  async quit(): Promise<void> {
    this.applyPending();
    for (const t of this.tracked.splice(0)) void t.snap?.snapshot.remove().catch(() => undefined);
    if (this.queue) await Promise.race([this.queue.cancel("quit"), new Promise((r) => setTimeout(r, QUIT_WAIT_MS))]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.off.splice(0)) off();
    void this.queue?.cancel("quit").catch(() => undefined);
    this.listeners.clear();
  }

  // -- the user's runs --

  /**
   * Before a question's run.start that starts a new conversation (App's start): with tuning on, a repo question's
   * folder is snapshotted. A refusal or a failure is a note, and the run goes ahead untuned (null).
   */
  async snapshotFor(run: StartRun): Promise<{ snap: Snap | null; note: string | null; tuned: boolean }> {
    if (!this.enabled) return { snap: null, note: null, tuned: false };
    if (run.mode !== "repo") return { snap: null, note: null, tuned: true };
    const r = await takeSnapshot(this.deps.home, run.repoPath ?? this.deps.cwd);
    if ("refused" in r) return { snap: null, note: `This task is ${r.refused}.`, tuned: false };
    return { snap: r, note: null, tuned: true };
  }

  /** The user's run is about to start; its run.finished for prompt 0 is offered to the queue. */
  track(request: StartRun, snap: Snap | null): TrackHandle {
    const t: Tracked = { request, snap, runId: null, started: null };
    this.tracked.push(t);
    return {
      resolved: (runId) => {
        if (t.runId === null) t.runId = runId;
        const seen = this.seen.get(runId);
        if (seen?.started) t.started ??= seen.started;
        if (seen?.finished) this.finished(t, seen.finished);
      },
      failed: () => this.forget(t),
    };
  }

  private forget(t: Tracked): void {
    this.tracked = this.tracked.filter((x) => x !== t);
    void t.snap?.snapshot.remove().catch(() => undefined);
  }

  private onEngine(method: string, params: any): void {
    if (typeof params?.run_id !== "string") return;
    // /tune's own runs are tagged `tune:…`; the app's own runs carry no tag
    if (typeof params.tag === "string" && params.tag !== "") return;
    if (method === "run.started" || method === "run.finished") {
      const s = this.seen.get(params.run_id) ?? {};
      if (method === "run.started") s.started = params as RunStartedParams;
      else if ((params.prompt_index ?? 0) === 0) s.finished = params as RunFinishedParams;
      this.seen.delete(params.run_id);
      this.seen.set(params.run_id, s);
      while (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value!);
      const t = this.tracked.find((x) => x.runId === params.run_id);
      if (t && method === "run.started") t.started = params as RunStartedParams;
      if (t && method === "run.finished" && (params.prompt_index ?? 0) === 0) this.finished(t, params as RunFinishedParams);
    }
    // the end of a one-shot run, or of a conversation: a pending switch applies, unless App is closing it itself
    const ended = method === "run.closed" || (method === "run.finished" && params.open !== true);
    if (ended && this.pending !== null && this.holding === 0) {
      queueMicrotask(() => {
        const note = this.conversationEnded();
        if (note !== null) this.store.note(note, "info");
      });
    }
  }

  /** run.finished for prompt 0: offered when it may be, else its snapshot goes (§7.6). */
  private finished(t: Tracked, f: RunFinishedParams): void {
    this.tracked = this.tracked.filter((x) => x !== t);
    const started = t.started;
    const problem = started === null ? "the run never started" : offerProblem(f, started.profile);
    if (problem !== null || !this.enabled || started === null) {
      void t.snap?.snapshot.remove().catch(() => undefined);
      return;
    }
    const task = taskFromRun({ home: this.deps.home, request: t.request, finished: f, profile: started.profile, root: started.root, sub: started.sub, ...(t.snap ? { snap: t.snap } : {}) });
    const r = this.ensureQueue().offer(task);
    if (r === "waiting") this.store.note(`/tune: this task (${task.id}) waits for the tune in flight.`, "info");
    this.bump();
  }

  // -- the queue's events --

  private onTuneEvent(e: TuneEvent): void {
    if (this.disposed) return;
    switch (e.type) {
      case "note":
        this.store.note(e.text, e.tone === "warn" ? "warn" : "info");
        break;
      case "off":
        this.store.note(e.text, "warn");
        break;
      case "task":
        if (e.phase === "start") this.store.note(`/tune: tuning ${e.id} in the background.`, "info");
        else if (e.result?.outcome === "base") this.store.note(`/tune: ${e.id} kept the base: ${e.result.reason ?? "no change was better"}.`, "info");
        break;
      case "kept":
        this.kept(e.name, e.base, e.changed);
        break;
      default:
        break;
    }
    this.bump();
  }

  /** No conversation is open and no run is going: a kept harness can become active now. */
  private quiet(): boolean {
    return !isActive(this.store.live().phase) && !(this.store.conversation()?.open ?? false);
  }

  private kept(name: string, base: string, changed: string[]): void {
    const what = `/tune kept ${name} (base ${base}, ${changes(changed.length)})`;
    if (this.quiet()) {
      this.pending = null;
      try {
        applySetting(this.deps, "profile", name);
        this.store.note(`${what}; it is now the active harness.`, "info");
      } catch (err) {
        this.store.note(`${what}, but it could not be made active: ${message(err)}`, "warn");
      }
      return;
    }
    this.pending = { name, expect: this.deps.session.settings.profile };
    this.store.note(`${what}; it becomes the active harness when this conversation ends.`, "info");
  }

  // -- the deferred switch --

  /** App closes a conversation itself (a new question, /clear); the switch waits for its conversationEnded(). */
  async holdingSwitch<T>(fn: () => Promise<T>): Promise<T> {
    this.holding += 1;
    try {
      return await fn();
    } finally {
      this.holding -= 1;
    }
  }

  /** The open conversation ended: a pending switch applies (the line to show), or is dropped when `profile` changed meanwhile. */
  conversationEnded(): string | null {
    if (this.pending === null || !this.quiet()) return null;
    return this.applyPending();
  }

  private applyPending(): string | null {
    const p = this.pending;
    if (p === null) return null;
    this.pending = null;
    this.bump();
    const now = this.deps.session.settings.profile;
    if (now !== p.expect) return `/tune: the switch to ${p.name} was dropped, because the profile changed to ${now}; /tuned still lists it.`;
    try {
      applySetting(this.deps, "profile", p.name);
      return `${p.name} is now the active harness.`;
    } catch (err) {
      return `/tune: ${p.name} could not be made active: ${message(err)}`;
    }
  }

  /** /tuned picked a harness: a pending switch from a tune is dropped. The line to show, or null. */
  dropPending(): string | null {
    const p = this.pending;
    if (p === null) return null;
    this.pending = null;
    this.bump();
    return `The pending switch to ${p.name} was dropped.`;
  }
}
