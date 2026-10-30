// KV cache: none
// The JSON-RPC 2.0 peer over a pair of streams (architecture §3, §7.1): the app's side of the
// engine's stdin and stdout. One UTF-8 JSON object per line, with requests both ways.
//
// Lines are split on raw bytes and each is decoded with a fatal UTF-8 decoder, so a character
// split across chunks survives, bad UTF-8 is answered with -32700, and the line limit counts
// bytes. A bad line is answered with an error, never a crash.

import { ErrorCode } from "./protocol.ts";

export const MAX_LINE_BYTES = 32 * 1024 * 1024;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const BLANK = /^[ \t\n\r\v\f]*$/;

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export type MessageKind = "request" | "notification" | "result" | "error" | "invalid";

type Json = Record<string, unknown>;
type Handler = (params: any, ctx: { signal: AbortSignal }) => Promise<unknown>;
type Listener = (...args: any[]) => void;

interface Pending {
  resolve(value: unknown): void;
  reject(err: RpcError): void;
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isId(v: unknown): v is string | number {
  return typeof v === "string" || Number.isInteger(v);
}

/** Link rule 3: what a parsed line is. */
export function classify(msg: unknown): MessageKind {
  if (!isObject(msg)) return "invalid";
  if ("method" in msg) {
    if (typeof msg.method !== "string") return "invalid";
    if (!("id" in msg)) return "notification";
    return isId(msg.id) ? "request" : "invalid";
  }
  if (!("id" in msg) || !(msg.id === null || isId(msg.id))) return "invalid";
  if ("result" in msg === "error" in msg) return "invalid";
  if ("result" in msg) return "result";
  const err = msg.error;
  return isObject(err) && Number.isInteger(err.code) && typeof err.message === "string" ? "error" : "invalid";
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function logError(text: string): void {
  process.stderr.write(`rlmh: ${text}\n`);
}

export class Link {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private readonly input: ReadableStream<Uint8Array>;
  private readonly output: { write(chunk: string): void | Promise<void> };
  private readonly idPrefix: string | undefined;
  private readonly maxLineBytes: number;
  private readonly handlers = new Map<string, Handler>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly pending = new Map<string | number, Pending>();
  private readonly running = new Set<AbortController>();
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private reader: { cancel(): Promise<void> } | undefined;
  private writes: Promise<void> = Promise.resolve();
  private nextId = 0;
  private isClosed = false;
  private parts: Uint8Array[] = []; // the line read so far
  private partBytes = 0;
  private dropping = false; // inside a line that went over the limit; skip to its \n

  /** idPrefix absent: integer ids from 1; present: `${idPrefix}${n}`. */
  constructor(
    input: ReadableStream<Uint8Array>,
    output: { write(chunk: string): void | Promise<void> },
    opts: { idPrefix?: string; maxLineBytes?: number } = {},
  ) {
    this.input = input;
    this.output = output;
    this.idPrefix = opts.idPrefix;
    this.maxLineBytes = opts.maxLineBytes ?? MAX_LINE_BYTES;
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve));
    void this.readLoop();
  }

  /** Send a request. Rejects with RpcError: the peer's error, or -32800 on abort or close. */
  request<R = unknown>(method: string, params: object, opts: { signal?: AbortSignal } = {}): Promise<R> {
    const { signal } = opts;
    if (this.isClosed) return Promise.reject(new RpcError(ErrorCode.CANCELLED, "link closed"));
    if (signal?.aborted) return Promise.reject(new RpcError(ErrorCode.CANCELLED, "cancelled"));
    this.nextId += 1;
    const id = this.idPrefix === undefined ? this.nextId : `${this.idPrefix}${this.nextId}`;
    let line: string;
    try {
      line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise<R>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id); // a late answer is then ignored
        reject(new RpcError(ErrorCode.CANCELLED, "cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const settled = () => signal?.removeEventListener("abort", onAbort);
      this.pending.set(id, {
        resolve: (value) => {
          settled();
          resolve(value as R);
        },
        reject: (err) => {
          settled();
          reject(err);
        },
      });
      this.writeLine(line);
    });
  }

  notify(method: string, params: object): void {
    if (!this.isClosed) this.writeLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Serve requests for `method`. A later call replaces the handler. */
  handle(method: string, fn: Handler): void {
    this.handlers.set(method, fn);
  }

  /** Listen for notifications; "*" receives (method, params). Returns an unsubscribe function. */
  onNotification(method: "*", fn: (method: string, params: any) => void): () => void;
  onNotification(method: string, fn: (params: any) => void): () => void;
  onNotification(method: string, fn: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** Link rule 8. Safe to call more than once. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const p of this.pending.values()) p.reject(new RpcError(ErrorCode.CANCELLED, "link closed"));
    this.pending.clear();
    for (const ac of this.running) ac.abort();
    this.running.clear();
    this.reader?.cancel().catch(() => {});
    this.resolveClosed();
  }

  // -- reading --

  private async readLoop(): Promise<void> {
    const reader = this.input.getReader();
    this.reader = reader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || this.isClosed) break;
        this.feed(value);
      }
    } catch {
      // a broken input counts as its end
    }
    if (!this.isClosed && !this.dropping && this.partBytes > 0) this.onLine(this.takeLine());
    this.close();
  }

  private feed(chunk: Uint8Array): void {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(NEWLINE, start);
      const end = nl < 0 ? chunk.length : nl;
      if (!this.dropping && end > start) {
        this.parts.push(chunk.slice(start, end));
        this.partBytes += end - start;
        if (this.partBytes > this.maxLineBytes) {
          this.dropping = true;
          this.parts = [];
          this.partBytes = 0;
          this.sendError(null, ErrorCode.INVALID_REQUEST, `line too long (over ${this.maxLineBytes} bytes)`);
        }
      }
      if (nl < 0) return;
      if (this.dropping) this.dropping = false;
      else this.onLine(this.takeLine());
      if (this.isClosed) return;
      start = nl + 1;
    }
  }

  private takeLine(): Uint8Array {
    const { parts, partBytes } = this;
    this.parts = [];
    this.partBytes = 0;
    if (parts.length === 1) return parts[0]!;
    const line = new Uint8Array(partBytes);
    let offset = 0;
    for (const part of parts) {
      line.set(part, offset);
      offset += part.length;
    }
    return line;
  }

  private onLine(bytes: Uint8Array): void {
    const end = bytes.length > 0 && bytes[bytes.length - 1] === CARRIAGE_RETURN ? bytes.length - 1 : bytes.length;
    let text: string;
    try {
      text = this.decoder.decode(bytes.subarray(0, end));
    } catch {
      this.sendError(null, ErrorCode.PARSE_ERROR, "parse error: invalid UTF-8");
      return;
    }
    if (BLANK.test(text)) return;
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch (err) {
      this.sendError(null, ErrorCode.PARSE_ERROR, `parse error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    switch (classify(msg)) {
      case "request":
        this.onRequest(msg);
        break;
      case "notification":
        this.onNotificationMessage(msg);
        break;
      case "result":
      case "error":
        this.onResponse(msg);
        break;
      default:
        this.sendError(isObject(msg) && isId(msg.id) ? msg.id : null, ErrorCode.INVALID_REQUEST, "invalid request");
    }
  }

  private onRequest(msg: { id: string | number; method: string; params?: unknown }): void {
    const handler = this.handlers.get(msg.method);
    if (!handler) {
      this.sendError(msg.id, ErrorCode.METHOD_NOT_FOUND, `method not found: ${msg.method}`);
      return;
    }
    const params = "params" in msg ? msg.params : {};
    if (!isObject(params)) {
      this.sendError(msg.id, ErrorCode.INVALID_PARAMS, "params must be an object");
      return;
    }
    const ac = new AbortController();
    this.running.add(ac);
    Promise.resolve()
      .then(() => handler(params, { signal: ac.signal }))
      .then(
        (result) => this.respond(msg.id, "result", result === undefined ? null : result),
        (err) => this.respond(msg.id, "error", errorObject(err)),
      )
      .finally(() => this.running.delete(ac));
  }

  private onNotificationMessage(msg: { method: string; params?: unknown }): void {
    const params = "params" in msg ? msg.params : {};
    if (!isObject(params)) {
      logError(`notification ${msg.method} ignored: params must be an object`);
      return;
    }
    for (const fn of [...(this.listeners.get(msg.method) ?? [])]) this.callListener(msg.method, () => fn(params));
    for (const fn of [...(this.listeners.get("*") ?? [])]) this.callListener(msg.method, () => fn(msg.method, params));
  }

  private callListener(method: string, call: () => void): void {
    try {
      call();
    } catch (err) {
      logError(`notification listener for ${method} failed: ${describe(err)}`);
    }
  }

  private onResponse(msg: { id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }): void {
    if (msg.id === null) return;
    const p = this.pending.get(msg.id);
    if (!p) return; // unknown, aborted or already answered
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve(msg.result);
  }

  // -- writing --

  private respond(id: string | number, key: "result" | "error", value: unknown): void {
    let line: string;
    try {
      line = JSON.stringify({ jsonrpc: "2.0", id, [key]: value });
    } catch (err) {
      line = JSON.stringify({ jsonrpc: "2.0", id, error: { code: ErrorCode.INTERNAL_ERROR, message: `internal error: ${describe(err)}` } });
    }
    this.writeLine(line);
  }

  private sendError(id: string | number | null, code: number, message: string): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  /** Writes are chained through one promise so their order holds; a failed write closes the link. */
  private writeLine(line: string): void {
    if (this.isClosed) return;
    const text = `${line}\n`;
    this.writes = this.writes.then(() => this.output.write(text)).then(
      () => {},
      () => this.close(),
    );
  }
}

function errorObject(err: unknown): { code: number; message: string; data?: unknown } {
  if (err instanceof RpcError) {
    return err.data === undefined ? { code: err.code, message: err.message } : { code: err.code, message: err.message, data: err.data };
  }
  return { code: ErrorCode.INTERNAL_ERROR, message: `internal error: ${describe(err)}` };
}
