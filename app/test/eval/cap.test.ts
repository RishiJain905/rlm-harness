// KV cache: none
// CostCap on a bare Bus (D-193): call.end costs summing past the cap cancel each running run exactly
// once, runs tracked afterwards are cancelled at once, and the cap stays tripped.

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
