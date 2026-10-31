// KV cache: none; a test helper.
// mount(deps) renders the real App through ink-testing-library and gives the tests the screen as
// text (ANSI stripped), every frame, key presses (each waits 30 ms for Ink to read it) and waitFor.

import { render } from "ink-testing-library";
import { createElement } from "react";
import { App } from "../../src/interface/App.tsx";
import type { AppDeps } from "../../src/interface/store.ts";

export const KEYS = {
  enter: "\r",
  esc: "\u001B",
  up: "\u001B[A",
  down: "\u001B[B",
  right: "\u001B[C",
  left: "\u001B[D",
  pageUp: "\u001B[5~",
  pageDown: "\u001B[6~",
  end: "\u001B[F",
  tab: "\t",
  backspace: "\u007F",
  ctrlH: "\b",
  ctrlC: "\u0003",
  ctrlU: "\u0015",
  ctrlO: "\u000F",
  ctrlV: "\u0016",
} as const;

const PRESS_MS = 30;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Mounted {
  /** The last frame, as text. */
  screen(): string;
  /** Every frame Ink wrote, as text (writes that were only escape sequences, such as bracketed-paste mode, are left out). */
  readonly frames: string[];
  press(key: string): Promise<void>;
  /** Writes `text` one character at a time. */
  type(text: string): Promise<void>;
  /** Polls until `fn` returns truthy (or doesn't throw), then returns its value; fails after `ms`. */
  waitFor<T>(fn: () => T, ms?: number): Promise<Exclude<T, false | null | undefined>>;
  /** Waits until the screen contains `text`. */
  waitForText(text: string, ms?: number): Promise<string>;
  unmount(): void;
}

export function mount(deps: AppDeps): Mounted {
  const size = deps.size ?? { columns: 100, rows: 30 };
  // Unicode on every OS, as Windows Terminal gets it (WT_SESSION), unless the test sets RLMH_ASCII
  const env = { WT_SESSION: "rlmh-test", ...(deps.env ?? {}) };
  const r = render(createElement(App, { deps: { ...deps, size, env } }));
  // ink-testing-library's stdout is 100 columns wide; give Ink the test's size instead
  Object.defineProperty(r.stdout, "columns", { get: () => size.columns });
  Object.defineProperty(r.stdout, "rows", { get: () => size.rows });
  r.stdout.emit("resize");
  const frames = () => r.frames.map(stripAnsi).filter((f) => f.trim() !== "" || f.includes("\n"));
  return {
    screen() {
      const all = frames();
      return all[all.length - 1] ?? "";
    },
    get frames() {
      return frames();
    },
    async press(key) {
      r.stdin.write(key);
      await sleep(PRESS_MS);
    },
    async type(text) {
      for (const ch of text) {
        r.stdin.write(ch);
        await sleep(5);
      }
      await sleep(PRESS_MS);
    },
    async waitFor(fn, ms = 5000) {
      const until = Date.now() + ms;
      let last: unknown;
      for (;;) {
        try {
          const v = fn();
          if (v) return v as Exclude<typeof v, false | null | undefined>;
          last = new Error("waitFor: the condition stayed false");
        } catch (err) {
          last = err;
        }
        if (Date.now() > until) throw last instanceof Error ? last : new Error(String(last));
        await sleep(20);
      }
    },
    async waitForText(text, ms = 5000) {
      try {
        return await this.waitFor(() => this.screen().includes(text) && this.screen(), ms);
      } catch {
        throw new Error(`waitForText: ${JSON.stringify(text)} never appeared. Last screen:\n${this.screen()}`);
      }
    },
    unmount() {
      r.unmount();
    },
  };
}
