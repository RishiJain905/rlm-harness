// KV cache: none; the interface never touches the bytes sent to the model.
// The approval queue between the engine's approval.request and the inline prompt: first in,
// first out. main.ts passes `ask` to Session.open; Approval.tsx answers the head.

import type { ApprovalParams, ApprovalResult } from "../protocol.ts";

const DENY: ApprovalResult = { allow: false, remember_for_run: false };

interface Pending {
  params: ApprovalParams;
  resolve(r: ApprovalResult): void;
}

export class ApprovalQueue {
  private readonly queue: Pending[] = [];
  private readonly listeners = new Set<() => void>();
  /** Bumps on every change, for useSyncExternalStore and to reset the prompt's highlight. */
  version = 0;

  /** Resolves when the request reaches the head and is answered, or when denyAll runs. */
  ask(p: ApprovalParams): Promise<ApprovalResult> {
    return new Promise((resolve) => {
      this.queue.push({ params: p, resolve });
      this.changed();
    });
  }

  /** The request on screen, or undefined. */
  head(): ApprovalParams | undefined {
    return this.queue[0]?.params;
  }

  /** How many are pending, the head included. */
  get size(): number {
    return this.queue.length;
  }

  answer(r: ApprovalResult): void {
    const head = this.queue.shift();
    if (!head) return;
    head.resolve({ allow: r.allow, remember_for_run: r.allow && r.remember_for_run });
    this.changed();
  }

  /** run.finished, engine.exit and quit: every pending request is denied. */
  denyAll(): void {
    if (this.queue.length === 0) return;
    for (const p of this.queue.splice(0)) p.resolve(DENY);
    this.changed();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private changed(): void {
    this.version += 1;
    for (const fn of [...this.listeners]) fn();
  }
}
