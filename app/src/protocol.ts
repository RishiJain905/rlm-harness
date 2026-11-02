// KV cache: none
// The wire types of architecture §3 to §5. protocol/examples.json holds one example of each
// message, and test/protocol.test.ts checks them against §4 and §5.

/** The §3 error codes, by the names link.py exports. */
export const ErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  MODEL_ERROR: -32001,
  UNKNOWN_RUN: -32010,
  UNKNOWN_PROFILE: -32011,
  BAD_INPUT: -32012,
  CANCELLED: -32800,
} as const;
export type ErrorCodeName = keyof typeof ErrorCode;

// -- §4 shared types --

export type Thinking = "off" | "low" | "medium" | "high";

/** `thinking: null` means the profile's default (D-08). */
export interface ModelRef {
  provider: string;
  model: string;
  thinking: Thinking | null;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** An assistant message carries at most one tool call (D-04). */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_call?: ToolCall }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** `input_tokens` counts every prompt token; cache reads and writes are subsets of it (D-22). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
}

export type ModelErrorKind =
  | "auth"
  | "no_key"
  | "bad_request"
  | "rate_limit"
  | "server"
  | "timeout"
  | "network"
  | "context_window"
  | "unknown_model"
  | "cancelled"
  | "other";

export interface ModelErrorData {
  kind: ModelErrorKind;
  provider: string;
  model: string;
  status: number | null;
  message: string;
}

/** The root turn and the line in that turn's cell. A sub-call an `rlm()` child makes also names the child (D-160); its
 *  `turn` and `line` are then the child's own turn and cell line. */
export interface Origin {
  turn: number;
  line: number | null;
  child?: number;
}

/** A single `llm()` call is a batch of one (D-24). */
export interface Batch {
  id: string;
  index: number;
  size: number;
}

export type PermissionMode = "default" | "accept-edits" | "bypass";
export type CallFormat = "fenced" | "native";
export type FinishReason = "stop" | "length" | "tool_call" | "content_filter" | "other";
export type ApprovalKind = "write" | "shell" | "network";

// -- §5.1 app -> engine --

/** One mode's limits as the engine runs them: contract.Limits.as_dict(). */
export interface ProfileLimits {
  max_turns: number;
  max_subcalls: number;
  root_max_tokens: number;
  output_max_chars: number;
  cell_timeout_s: number;
  cpus: number;
  memory_mb: number;
  pids: number;
  grader_timeout_s: number | null;
  subcall_max_chars: number;
  subcall_max_tokens: number;
  subcall_thinking: string | null;
  subcall_oversize: string;
}

export interface ProfileInfo {
  name: string;
  source: "builtin" | "user";
  prompt_hash: string;
  profile_hash: string;
  /** v1 step 2 (D-198): an added field, so the protocol number stays. */
  agent_api: boolean;
  limits: { read: ProfileLimits; repo: ProfileLimits };
}

/** `contract*` and `profiles` are null and [] until step 3. */
export interface EngineInfo {
  version: string;
  protocol: number;
  python: string;
  contract: string | null;
  contract_hash: string | null;
  training_hash: string | null;
  profiles: ProfileInfo[];
}

export interface RunStartParams {
  mode: "read" | "repo";
  question?: string;
  inputs?: string[];
  task?: string;
  repo_path?: string;
  test_hint?: string;
  language?: string;
  n_files?: number;
  context?: string;
  profile: string;
  root: ModelRef;
  sub: ModelRef;
  permission_mode: PermissionMode;
  call_format: CallFormat;
  interactive?: boolean;
  tag?: string;
  batch?: string;
  log_dir?: string;
}

export interface RunStartResult {
  run_id: string;
  log_path: string;
}

export interface RunCancelParams {
  run_id: string;
}

export interface RunVarsParams {
  run_id: string;
}

export interface VarInfo {
  name: string;
  type: string;
  len: number | null;
  chars: number;
}

export interface RunVarsResult {
  vars: VarInfo[];
}

export interface DebugRoundtripParams {
  count: number;
}

export interface DebugRoundtripResult {
  texts: string[];
}

// -- §5.2 engine -> app --

export interface ModelCompleteParams {
  run_id: string;
  role: "root" | "sub";
  model: ModelRef;
  messages: Message[];
  tools: ToolDef[];
  max_tokens: number;
  temperature: number;
  thinking: Thinking;
  turn: number;
  subcall_id?: number;
  origin?: Origin;
  batch?: Batch;
  /** Sub-calls only: the first `chars` UTF-16 code units of the user message are a stable prefix (a context segment or a
   *  batch's shared preamble) that many calls repeat byte for byte; `key` names it. The gateway marks and routes it
   *  for the provider's cache (D-119). */
  prefix?: { chars: number; key: string };
  /** A root turn of an `rlm()` child run (D-160): `role` is "sub", `subcall_id` is the child's row, and the conversation
   *  grows turn by turn like a root's, so the gateway caches and routes it as one (cache.ts routeKey). */
  child?: ChildTurn;
}

/** Which child run a `model.complete` turn belongs to: its id, this turn and the child's limit, and its depth (1: the
 *  root's own child). */
export interface ChildTurn {
  id: number;
  turn: number;
  max_turns: number;
  depth: number;
}

export interface ModelCompleteResult {
  text: string;
  tool_call: ToolCall | null;
  reasoning: string | null;
  usage: Usage;
  finish_reason: FinishReason;
  served_model: string;
  seconds: number;
}

export interface ApprovalParams {
  run_id: string;
  kind: ApprovalKind;
  detail: string;
  turn: number;
  inside_workspace: boolean;
}

export interface ApprovalResult {
  allow: boolean;
  remember_for_run: boolean;
}

// -- §5.3 events (engine -> app notifications) --

export interface RunLimits {
  max_turns: number;
  max_subcalls: number;
  root_max_tokens: number;
  output_max_chars: number;
  cell_timeout_s: number;
  subcall_max_chars: number;
  subcall_max_tokens: number;
}

export interface RunInputInfo {
  chars: number;
  lines: number;
  sha256: string;
  files: string[];
}

export interface RunStartedParams {
  run_id: string;
  tag: string | null;
  mode: "read" | "repo";
  profile: string;
  prompt_hash: string;
  profile_hash: string;
  contract_hash: string;
  call_format: CallFormat;
  root: ModelRef;
  sub: ModelRef;
  permission_mode: PermissionMode;
  workspace: string;
  input: RunInputInfo;
  limits: RunLimits;
  log_path: string;
}

export interface RunReplyParams {
  run_id: string;
  turn: number;
  text: string;
  tool_call: ToolCall | null;
  reasoning: string | null;
  finish_reason: FinishReason;
  usage: Usage;
  seconds: number;
}

export interface RunCellParams {
  run_id: string;
  turn: number;
  code: string | null;
  output: string;
  error: string | null;
  observation: string | null;
  seconds: number;
  restarted: boolean;
  crash: string | null;
  repo_changed: boolean | null;
}

export interface RunSubcallParams {
  run_id: string;
  subcall_id: number | null;
  origin: Origin;
  batch: Batch;
  prompt_chars: number;
  status: "sent" | "done" | "error" | "rejected";
  error: string | null;
  seconds: number | null;
}

/** One `rlm()` child run's progress (D-160): "started" once, "turn" after each of its cells (that cell's code, output and
 *  error), then "done" (with `answer`) or "error". The child's row also gets the usual run.subcall sent/done/error. */
export interface RunChildParams {
  run_id: string;
  child_id: number;
  subcall_id: number;
  depth: number;
  status: "started" | "turn" | "done" | "error";
  task: string;
  tools: string;
  turn: number;
  max_turns: number;
  code: string | null;
  output: string | null;
  error: string | null;
  answer: unknown;
  seconds: number | null;
}

export interface RunPermissionParams {
  run_id: string;
  turn: number;
  kind: ApprovalKind;
  detail: string;
  allowed: boolean;
  asked: boolean;
  remembered: boolean;
}

export interface RunBudgetParams {
  run_id: string;
  turns_left: number;
  subcalls_left: number;
}

export interface RunFinishedParams {
  run_id: string;
  tag: string | null;
  /** The submitted value (D-89): a string, a number or a list of those, or null when nothing valid was submitted. */
  answer: string | number | (string | number)[] | null;
  submitted: boolean;
  answer_valid: boolean;
  turns: number;
  subcalls: number;
  usage: { root: Usage; sub: Usage };
  cost_usd: number;
  infra_error: string | null;
  infra_kind: string | null;
  wall_s: number;
  log_path: string;
}

export interface ModelCancelParams {
  run_id: string;
}

/** Every engine notification, by method. */
export type EngineEvents = {
  "run.started": RunStartedParams;
  "run.reply": RunReplyParams;
  "run.cell": RunCellParams;
  "run.subcall": RunSubcallParams;
  "run.child": RunChildParams;
  "run.permission": RunPermissionParams;
  "run.budget": RunBudgetParams;
  "run.finished": RunFinishedParams;
  "model.cancel": ModelCancelParams;
};
