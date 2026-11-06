// KV cache: none
// CostCap on a bare Bus (D-193): call.end costs summing past the cap cancel each running run exactly
// once, runs tracked afterwards are cancelled at once, and the cap stays tripped; with trackedOnly (v1 step 9)
// only the tracked runs count.

import { expect, test } from "bun:test";
import { Bus } from "../../src/bus.ts";
import { CostCap } from "../../src/eval/runner.ts";
import type { AppEvents } from "../../src/gateway/gateway.ts";

const end = (bus: Bus<AppEvents>, run: string, usd: number) =>
  bus.emit("call.end", {
    call_id: `${run}-${usd}`,
    run_id: run,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: usd },
    finish_reason: "stop",
    seconds: 0,
  });

test("passing the cap cancels each running run once and stops new starts", () => {
  const bus = new Bus<AppEvents>();
  const cancelled: string[] = [];
  const cap = new CostCap(bus, 1.0, (id) => cancelled.push(id));
  cap.track("a");
  cap.track("b");
  end(bus, "a", 0.6);
  end(bus, "b", 0.4); // exactly at the cap: not past it
  expect(cap.capped).toBe(false);
  expect(cancelled).toEqual([]);
  end(bus, "a", 0.01);
  expect(cap.capped).toBe(true);
  expect(cancelled.sort()).toEqual(["a", "b"]);
  end(bus, "b", 0.5);
  expect(cancelled.length).toBe(2);
  cap.untrack("a");
  cap.track("c"); // a start after the cap tripped
  expect(cancelled).toContain("c");
  cap.track("c");
  expect(cancelled.filter((x) => x === "c").length).toBe(1);
  expect(cap.total).toBeCloseTo(1.51, 10);
  cap.dispose();
  end(bus, "a", 5);
  expect(cap.total).toBeCloseTo(1.51, 10);
});

test("no cap never cancels", () => {
  const bus = new Bus<AppEvents>();
  const cap = new CostCap(bus, null, () => {
    throw new Error("cancelled");
  });
  cap.track("a");
  end(bus, "a", 1000);
  expect(cap.capped).toBe(false);
});

test("trackedOnly counts only tracked runs, a call.end before its run's track included, and reports each total", () => {
  const bus = new Bus<AppEvents>();
  const cancelled: string[] = [];
  const totals: number[] = [];
  const cap = new CostCap(bus, 1.0, (id) => cancelled.push(id), () => {}, { trackedOnly: true, onCost: (t) => totals.push(t) });
  end(bus, "user", 5); // the user's own run on the same bus: never counted
  end(bus, "a", 0.3); // before "a" is tracked: held
  expect(cap.total).toBe(0);
  cap.track("a");
  expect(cap.total).toBeCloseTo(0.3, 10);
  end(bus, "a", 0.5);
  end(bus, "user", 5);
  expect(cap.capped).toBe(false);
  end(bus, "a", 0.3);
  expect(cap.capped).toBe(true);
  expect(cancelled).toEqual(["a"]);
  expect(totals.map((x) => Math.round(x * 10) / 10)).toEqual([0.3, 0.8, 1.1]);
  cap.dispose();
});
