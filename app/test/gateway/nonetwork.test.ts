// KV cache: none
// S-06: saving, listing and resolving keys, building a Gateway, reading the catalog and totals make
// no network request at all. Every way out (fetch, sockets, http, https, DNS, WebSocket) is a counter
// that fails; the positive controls show the counters do move when a request is made.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { KeyStore, checkFormat } from "../../src/gateway/keys.ts";
import { startFakeProvider, openaiStream, type FakeServer } from "../fakes/http.ts";
import { KEYS, memorySecrets, params, ref, rig, type Rig } from "./helpers.ts";

const realFetch = globalThis.fetch;
const realConnect = net.Socket.prototype.connect;
const realHttpRequest = http.request;
const realHttpsRequest = https.request;
const realLookup = dns.lookup;
const realWebSocket = globalThis.WebSocket;

const counts = { fetch: 0, connect: 0, http: 0, https: 0, dns: 0, websocket: 0 };
/** What the Gateway's own fetch was asked for. */
let gatewayCount = 0;
/** Where the Gateway's fetch goes: nowhere (a failure) unless a positive control points it at the fake server. */
let gatewayTarget: typeof fetch | null = null;

const countingFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  gatewayCount += 1;
  if (!gatewayTarget) throw new Error("nonetwork: the Gateway made a request");
  return gatewayTarget(input, init);
}) as typeof fetch;

function trap(name: keyof typeof counts): never {
  counts[name] += 1;
  throw new Error(`nonetwork: ${name} was called`);
}

let server: FakeServer;
let r: Rig | undefined;

beforeAll(() => {
  server = startFakeProvider();
});
afterAll(() => {
  server.stop();
});

beforeEach(() => {
  for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] = 0;
  gatewayCount = 0;
  gatewayTarget = null;
  globalThis.fetch = ((..._args: unknown[]) => trap("fetch")) as unknown as typeof fetch;
  net.Socket.prototype.connect = function () {
    return trap("connect");
  } as typeof net.Socket.prototype.connect;
  http.request = ((..._args: unknown[]) => trap("http")) as typeof http.request;
  https.request = ((..._args: unknown[]) => trap("https")) as typeof https.request;
  dns.lookup = ((..._args: unknown[]) => trap("dns")) as unknown as typeof dns.lookup;
  globalThis.WebSocket = function () {
    return trap("websocket");
  } as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  net.Socket.prototype.connect = realConnect;
  http.request = realHttpRequest;
  https.request = realHttpsRequest;
  dns.lookup = realLookup;
  globalThis.WebSocket = realWebSocket;
  r?.cleanup();
  r = undefined;
});

const ZERO = { fetch: 0, connect: 0, http: 0, https: 0, dns: 0, websocket: 0 };

test("the traps are in place", () => {
  expect(() => fetch("https://example.invalid/")).toThrow("nonetwork: fetch was called");
  expect(() => new WebSocket("wss://example.invalid/")).toThrow("nonetwork: websocket was called");
  expect(() => http.request("http://example.invalid/")).toThrow("nonetwork: http was called");
  expect(() => https.request("https://example.invalid/")).toThrow("nonetwork: https was called");
  expect(() => dns.lookup("example.invalid", () => undefined)).toThrow("nonetwork: dns was called");
  expect(() => new net.Socket().connect(443, "example.invalid")).toThrow("nonetwork: connect was called");
  expect(counts).toEqual({ fetch: 1, connect: 1, http: 1, https: 1, dns: 1, websocket: 1 });
});

test("keys, a new Gateway, the catalog and totals make no request", async () => {
  r = await rig({ fetch: countingFetch });
  const { keys, gateway, catalog } = r;

  expect(checkFormat("anthropic", KEYS.anthropic!)).toBeNull();
  expect(checkFormat("openai", "FAKE-not-a-key")).not.toBeNull();
  const a = await keys.add("anthropic", KEYS.anthropic!, "work");
  const b = await keys.add("anthropic", "sk-ant-FAKE-second-key-000000000b2c4");
  await keys.setActive("anthropic", b.id);
  expect((await keys.list("anthropic")).map((k) => k.active)).toEqual([false, true]);
  expect((await keys.resolve("anthropic"))?.source).toBe("secrets");
  await keys.remove("anthropic", b.id);
  expect(await keys.list()).toEqual([{ ...a, active: true }]);
  expect((await keys.resolve("anthropic"))?.key).toBe(KEYS.anthropic!);

  // The file store too: on Windows its lock runs whoami and icacls, which are local processes.
  const fileKeys = new KeyStore({ home: r.home, secrets: memorySecrets(), env: { RLMH_KEY_STORE: "file" } });
  const f = await fileKeys.add("openai", KEYS.openai!);
  expect((await fileKeys.resolve("openai"))?.source).toBe("file");
  await fileKeys.remove("openai", f.id);

  expect(catalog.models().length).toBeGreaterThan(0);
  expect(catalog.models("anthropic").length).toBeGreaterThan(0);
  expect(gateway.totals("r_0123456789ab")).toMatchObject({ cost_usd: 0, cache_hit_rate: null });

  expect(counts).toEqual(ZERO);
  expect(gatewayCount).toBe(0);
});

test("positive control: one complete is one Gateway request", async () => {
  gatewayTarget = server.redirectFetch(realFetch);
  server.script(() => openaiStream({ text: "hello" }));
  server.requests.length = 0;
  r = await rig({ fetch: countingFetch, keys: ["openai"] });
  const result = await r.gateway.complete(params(ref("openai", "gpt-4.1")));
  expect(result.text).toBe("hello");
  expect(gatewayCount).toBe(1);
  expect(server.requests).toHaveLength(1);
  expect(counts).toEqual(ZERO);
});

test("positive control: one refreshModels is exactly one request", async () => {
  gatewayTarget = server.redirectFetch(realFetch);
  server.script(() => Response.json({ object: "list", data: [{ id: "gpt-4.1" }, { id: "gpt-nonetwork-FAKE" }] }));
  server.requests.length = 0;
  r = await rig({ fetch: countingFetch, keys: ["openai"] });
  const models = await r.gateway.refreshModels("openai");
  expect(models.map((m) => m.id)).toEqual(["gpt-4.1", "gpt-nonetwork-FAKE"]);
  expect(gatewayCount).toBe(1);
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0]!.path).toBe("/v1/models");
  expect(counts).toEqual(ZERO);
});
