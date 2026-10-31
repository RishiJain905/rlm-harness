// KV cache: none; the interface never touches the bytes sent to the model.
// The slash commands. Each has one screen that replaces the transcript and panel area; /quit has
// none and is handled in App.tsx.

import type { ReactElement } from "react";
import type { AppDeps, RunStore, RunView } from "../store.ts";
import { ContextScreen } from "./context.tsx";
import { HelpScreen } from "./help.tsx";
import { ModelScreen } from "./model.tsx";
import { PermissionsScreen } from "./permissions.tsx";
import { ProvidersScreen } from "./providers.tsx";
import { RunsScreen } from "./runs.tsx";
import { SettingsScreen } from "./settings.tsx";

export interface ScreenProps {
  deps: AppDeps;
  store: RunStore;
  /** The current run's view, as App last drew it. */
  view: RunView;
  close(): void;
  /** The mode the next run uses; /permissions changes it for this session only. */
  permissionMode: string;
  setPermissionMode(m: string): void;
  /** false while an approval or a confirmation has the keyboard. */
  active: boolean;
  width: number;
  height: number;
}

export interface SlashCommand {
  name: string;
  summary: string;
  Screen: (p: ScreenProps) => ReactElement;
}

export const COMMANDS: readonly SlashCommand[] = [
  { name: "providers", summary: "Add, list and delete keys per provider; refresh models", Screen: ProvidersScreen },
  { name: "model", summary: "Pick the root and sub-call models and their thinking", Screen: ModelScreen },
  { name: "settings", summary: "Every setting, as rlmh config shows them", Screen: SettingsScreen },
  { name: "permissions", summary: "The next run's mode, and what this run allowed", Screen: PermissionsScreen },
  { name: "context", summary: "The root prompt against its window, and the REPL's variables", Screen: ContextScreen },
  { name: "runs", summary: "Past runs from the run log, replayed read-only", Screen: RunsScreen },
  { name: "help", summary: "Commands and keys", Screen: HelpScreen },
];

export const QUIT = { name: "quit", summary: "Deny approvals, cancel the run, and quit" };

/** The slash menu's matches for what is typed: `/` then a name prefix, no space yet. */
export function slashMatches(value: string): { name: string; summary: string }[] {
  if (!value.startsWith("/") || /\s/.test(value)) return [];
  const typed = value.slice(1).toLowerCase();
  return [...COMMANDS, QUIT].filter((c) => c.name.startsWith(typed)).map(({ name, summary }) => ({ name, summary }));
}

export const KEYS: readonly [string, string][] = [
  ["Enter", "submit the prompt; choose in a list"],
  ["Esc", "deny the approval; close the screen; cancel the run; clear the prompt"],
  ["Ctrl+C", "cancel the run; when idle, twice within 2 s quits"],
  ["Tab", "complete /command or @path; on an empty prompt, select in the sub-call panel"],
  ["Up / Down", "prompt history; in the panel, move the selection"],
  ["PageUp / PageDown", "scroll the transcript"],
  ["End", "follow the transcript's tail"],
  ["Ctrl+O", "show transcript entries in full, or capped again"],
  ["y / a / n", "approval: allow once, allow for this run, deny"],
  ["Backspace", "delete left"],
];
