// KV cache: none
// What the two streaming readers (openai.ts, anthropic.ts) share with gateway.ts: their hooks,
// what one attempt returns, and the one error an attempt fails with, so gateway.ts can retry
// and classify without knowing either SDK.

import type { FinishReason } from "../protocol.ts";

export interface StreamHooks {
  /** Every stream event, content or not; resets the idle timer. */
  onEvent(): void;
  /** Any text, reasoning or tool-call delta, or an Anthropic content_block_start (the batch gate's first token). */
  onContent(): void;
  onText(text: string): void;
  onReasoning(text: string): void;
}

export interface StreamToolCall {
  id: string | null;
  name: string;
  /** The arguments as streamed, a JSON string. */
  arguments: string;
}

/** What a provider needs back on the assistant message of a tool-call turn (D-33). */
export interface Replay {
  thinking_blocks?: Record<string, unknown>[]; // Anthropic
  reasoning_content?: string; // DeepSeek
  reasoning_details?: unknown[]; // OpenRouter
  extra_content?: unknown; // Gemini, on the tool call
}

export interface StreamResult {
  text: string;
  reasoning: string;
  toolCall: StreamToolCall | null;
  finish: FinishReason | null;
  served: string | null;
  /** The provider's own usage object, or null when the stream had none. */
  usage: unknown;
  /** Everything the replay table might keep; gateway.ts picks per provider. */
  replay: Replay;
}

export type FailureKind = "http" | "stream" | "network" | "timeout" | "aborted" | "bad_stream";

export interface Failure {
  kind: FailureKind;
  status: number | null;
  /** The provider's own message, not yet redacted or cut. */
  detail: string;
  headers?: Headers;
  /** The provider's error code or type, e.g. insufficient_quota. */
  code?: string;
}

export class AttemptError extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(failure.detail);
    this.name = "AttemptError";
    this.failure = failure;
  }
}

/** One SDK's error classes; both SDKs have the same four. */
export interface SdkErrors {
  APIError: abstract new (...args: any[]) => Error;
  APIConnectionError: abstract new (...args: any[]) => Error;
  APIConnectionTimeoutError: abstract new (...args: any[]) => Error;
  APIUserAbortError: abstract new (...args: any[]) => Error;
}

/**
 * An SDK error as an AttemptError: an abort, a timeout, a connection error, an HTTP status, an
 * error event inside the stream (an APIError with no status), or a stream we could not parse.
 * Anything else broke while reading the body, which counts as a dropped connection.
 */
export function sdkAttemptError(err: unknown, sdk: SdkErrors): AttemptError {
  if (err instanceof AttemptError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof sdk.APIUserAbortError || (err instanceof Error && err.name === "AbortError")) {
    return new AttemptError({ kind: "aborted", status: null, detail: "aborted" });
  }
  if (err instanceof sdk.APIConnectionTimeoutError) return new AttemptError({ kind: "timeout", status: null, detail: message });
  if (err instanceof sdk.APIConnectionError) return new AttemptError({ kind: "network", status: null, detail: causeText(err) });
  if (err instanceof sdk.APIError) {
    const e = err as Error & { status?: unknown; error?: unknown; headers?: unknown };
    const detail = errorDetail(e.error, message);
    const code = errorCode(e.error);
    if (typeof e.status === "number") {
      return new AttemptError({ kind: "http", status: e.status, detail, headers: e.headers instanceof Headers ? e.headers : undefined, code });
    }
    return new AttemptError({ kind: "stream", status: null, detail, code });
  }
  if (err instanceof SyntaxError) return new AttemptError({ kind: "bad_stream", status: null, detail: message });
  return new AttemptError({ kind: "network", status: null, detail: causeText(err) });
}

/** The provider's message from an SDK error body: OpenAI's `{message}`, Anthropic's `{error: {message}}`. */
export function errorDetail(body: unknown, fallback: string): string {
  if (isObject(body)) {
    if (isObject(body.error) && typeof body.error.message === "string") return body.error.message;
    if (typeof body.message === "string") return body.message;
    return JSON.stringify(body);
  }
  return typeof body === "string" && body !== "" ? body : fallback;
}

export function errorCode(body: unknown): string | undefined {
  const inner = isObject(body) && isObject(body.error) ? body.error : body;
  if (!isObject(inner)) return undefined;
  for (const k of ["code", "type"]) if (typeof inner[k] === "string") return inner[k] as string;
  return undefined;
}

/** The cause of a connection error, as one line. */
export function causeText(err: unknown): string {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e instanceof Error && e.cause !== undefined; depth++) e = e.cause;
  const text = e instanceof Error ? e.message || e.name : String(e);
  return text.split("\n")[0]!.trim() || "connection failed";
}

export function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
