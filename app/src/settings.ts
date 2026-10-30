// KV cache: none
// The one settings schema (architecture §8), and settings.toml in the runtime home.
// `/settings` and `rlmh config` read SCHEMA; a dotted key is a TOML table path.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { settingsPath } from "./paths.ts";

export type SettingType = "string" | "enum" | "int" | "bool";
export type SettingValue = string | number | boolean;

export interface SettingDef {
  key: string;
  type: SettingType;
  default: SettingValue;
  choices?: readonly string[];
  doc: string;
}

const THINKING = ["default", "off", "low", "medium", "high"] as const;
const PERMISSION_MODES = ["default", "accept-edits", "bypass"] as const;
const CALL_FORMATS = ["auto", "fenced", "native"] as const;
const LOCAL_BASE_URL = "http://localhost:8000/v1";

/** Step 5 adds the check against the provider list. */
export const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/;

/** In §8 order. `<id>` stands for a provider id. */
export const SCHEMA: readonly SettingDef[] = [
  { key: "root.model", type: "string", default: "", doc: "Root model as provider/model; empty until one is picked" },
  { key: "root.thinking", type: "enum", default: "default", choices: THINKING, doc: "Root model thinking; default uses the profile's" },
  { key: "sub.model", type: "string", default: "", doc: "Sub-call model as provider/model; empty uses root.model" },
  { key: "sub.thinking", type: "enum", default: "default", choices: THINKING, doc: "Sub-call thinking; default uses the profile's" },
  { key: "profile", type: "string", default: "default", doc: "Prompt profile, such as default or training-v4" },
  {
    key: "permissions.mode",
    type: "enum",
    default: "accept-edits",
    choices: PERMISSION_MODES,
    doc: "default asks for writes, shell and network; accept-edits lets workspace writes through; bypass asks nothing",
  },
  {
    key: "call_format",
    type: "enum",
    default: "auto",
    choices: CALL_FORMATS,
    doc: "How the root model sends code: auto is native for API models, fenced otherwise",
  },
  { key: "providers.<id>.base_url", type: "string", default: "", doc: "API base URL, for local and custom providers" },
  { key: "providers.<id>.max_in_flight", type: "int", default: 16, doc: "Most calls in flight at once to this provider" },
  { key: "display.verbose", type: "bool", default: false, doc: "Show the engine's stderr" },
];

export type ThinkingSetting = (typeof THINKING)[number];

export interface ProviderSettings {
  base_url?: string;
  max_in_flight?: number;
}

export interface Settings {
  root: { model: string; thinking: ThinkingSetting };
  sub: { model: string; thinking: ThinkingSetting };
  profile: string;
  permissions: { mode: (typeof PERMISSION_MODES)[number] };
  call_format: (typeof CALL_FORMATS)[number];
  providers: Record<string, ProviderSettings>;
  display: { verbose: boolean };
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

type Table = Record<string, unknown>;

const PROVIDER_DEFS = SCHEMA.filter((d) => d.key.startsWith("providers.<id>."));

export function defaultSettings(): Settings {
  const s: Table = {};
  for (const def of SCHEMA) {
    if (PROVIDER_DEFS.includes(def)) s.providers ??= {};
    else setPath(s, def.key.split("."), def.default);
  }
  return s as unknown as Settings;
}

/** A missing file gives the defaults. Bad TOML, an unknown key or a wrong type throws; the file is never rewritten. */
export function loadSettings(home: string): Settings {
  const file = settingsPath(home);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultSettings();
    throw new SettingsError(`${file}: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = Bun.TOML.parse(text);
  } catch (err) {
    throw new SettingsError(`${file}: bad TOML: ${(err as Error).message}`);
  }
  const s = defaultSettings() as unknown as Table;
  try {
    for (const [key, value] of leaves(data as Table, [])) {
      const { def, path } = lookup(key);
      setPath(s, path, check(def, key, value, false));
    }
  } catch (err) {
    throw new SettingsError(`${file}: ${(err as Error).message}`);
  }
  return s as unknown as Settings;
}

/** Writes settings.toml.tmp, then renames it over settings.toml. */
export function saveSettings(home: string, s: Settings): void {
  mkdirSync(home, { recursive: true });
  const file = settingsPath(home);
  writeFileSync(`${file}.tmp`, toToml(s as unknown as Table));
  renameSync(`${file}.tmp`, file);
}

export function getSetting(s: Settings, key: string): SettingValue {
  const { def, path } = lookup(key);
  const value = getPath(s as unknown as Table, path);
  return value === undefined ? defaultFor(def, path) : (value as SettingValue);
}

/** Pure: returns a new object. A string is coerced to the key's type ("true"/"false", whole numbers). */
export function setSetting(s: Settings, key: string, value: unknown): Settings {
  const { def, path } = lookup(key);
  const next = structuredClone(s) as unknown as Table;
  setPath(next, path, check(def, key, value, true));
  return next as unknown as Settings;
}

/** Every key in SCHEMA order; provider keys for each provider that has settings. */
export function listSettings(s: Settings): [string, SettingValue][] {
  const out: [string, SettingValue][] = [];
  for (const def of SCHEMA) {
    if (def === PROVIDER_DEFS[0]) {
      for (const id of Object.keys(s.providers)) {
        for (const pdef of PROVIDER_DEFS) {
          const key = pdef.key.replace("<id>", id);
          out.push([key, getSetting(s, key)]);
        }
      }
    } else if (!PROVIDER_DEFS.includes(def)) {
      out.push([def.key, getSetting(s, def.key)]);
    }
  }
  return out;
}

// -- private --

function lookup(key: string): { def: SettingDef; path: string[] } {
  const path = key.split(".");
  if (path[0] === "providers" && path.length === 3) {
    const def = PROVIDER_DEFS.find((d) => d.key === `providers.<id>.${path[2]}`);
    if (def) {
      if (!PROVIDER_ID.test(path[1]!)) {
        throw new SettingsError(`bad provider id "${path[1]}" in ${key}: use a lowercase letter, then lowercase letters, digits, _ or -`);
      }
      return { def, path };
    }
  } else if (path[0] !== "providers") {
    const def = SCHEMA.find((d) => d.key === key);
    if (def) return { def, path };
  }
  const isTable = path[0] === "providers" ? path.length <= 2 : SCHEMA.some((d) => d.key.startsWith(`${key}.`));
  throw new SettingsError(isTable ? `${key} is a table; set one of its keys` : `unknown setting "${key}"`);
}

function defaultFor(def: SettingDef, path: string[]): SettingValue {
  return def.key === "providers.<id>.base_url" && path[1] === "local" ? LOCAL_BASE_URL : def.default;
}

function check(def: SettingDef, key: string, value: unknown, coerce: boolean): SettingValue {
  const got = typeof value === "string" ? JSON.stringify(value) : String(value);
  switch (def.type) {
    case "string":
      if (typeof value === "string") return value;
      throw new SettingsError(`${key} must be a string (got ${got})`);
    case "enum":
      if (typeof value === "string" && def.choices!.includes(value)) return value;
      throw new SettingsError(`${key} must be one of ${def.choices!.join(", ")} (got ${got})`);
    case "bool":
      if (typeof value === "boolean") return value;
      if (coerce && (value === "true" || value === "false")) return value === "true";
      throw new SettingsError(`${key} must be true or false (got ${got})`);
    case "int": {
      const n = coerce && typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 1) return n;
      throw new SettingsError(`${key} must be a whole number, 1 or more (got ${got})`);
    }
  }
}

function isTable(v: unknown): v is Table {
  return Object.prototype.toString.call(v) === "[object Object]";
}

function* leaves(table: Table, prefix: string[]): Generator<[string, unknown]> {
  for (const [k, v] of Object.entries(table)) {
    if (isTable(v)) yield* leaves(v, [...prefix, k]);
    else yield [[...prefix, k].join("."), v];
  }
}

function getPath(table: Table, path: string[]): unknown {
  let node: unknown = table;
  for (const part of path) {
    if (!isTable(node)) return undefined;
    node = node[part];
  }
  return node;
}

function setPath(table: Table, path: string[], value: unknown): void {
  let node = table;
  for (const part of path.slice(0, -1)) {
    if (!isTable(node[part])) node[part] = {};
    node = node[part] as Table;
  }
  node[path[path.length - 1]!] = value;
}

/** Top-level scalars first, then one [table] per table that holds scalars. Strings via JSON.stringify. */
function toToml(root: Table): string {
  const lines: string[] = [];
  const emit = (table: Table, path: string[]) => {
    const entries = Object.entries(table);
    const scalars = entries.filter(([, v]) => !isTable(v));
    if (path.length > 0 && scalars.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(`[${path.map(tomlKey).join(".")}]`);
    }
    for (const [k, v] of scalars) lines.push(`${tomlKey(k)} = ${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
    for (const [k, v] of entries) if (isTable(v)) emit(v, [...path, k]);
  };
  emit(root, []);
  return `${lines.join("\n")}\n`;
}

function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}
