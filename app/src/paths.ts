// KV cache: none
// The runtime folders (architecture §9). These helpers only build paths; they create nothing.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function home(env: Record<string, string | undefined> = process.env): string {
  const h = env.RLMH_HOME;
  return h ? resolve(h) : join(homedir(), ".rlm-harness");
}

export function settingsPath(h = home()): string {
  return join(h, "settings.toml");
}

export function keyIndexPath(h = home()): string {
  return join(h, "key-index.json");
}

export function keysPath(h = home()): string {
  return join(h, "keys.json");
}

export function refreshedModelsPath(h = home()): string {
  return join(h, "models-refreshed.json");
}

export function profilesDir(h = home()): string {
  return join(h, "profiles");
}

export function runsDir(h = home()): string {
  return join(h, "runs");
}

export function scratchDir(runId: string, h = home()): string {
  return join(h, "scratch", runId);
}

export function pythonDir(h = home()): string {
  return join(h, "python");
}

export function engineDir(version: string, h = home()): string {
  return join(h, "engine", version);
}

export function binDir(h = home()): string {
  return join(h, "bin");
}
