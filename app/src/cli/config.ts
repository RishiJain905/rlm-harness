// KV cache: none
// `rlmh config get KEY | set KEY VALUE | list` (architecture §8, §10). It reads and writes
// settings.toml only: it never starts the engine and makes no request.

import { getSetting, listSettings, loadSettings, saveSettings, setSetting, SettingsError, type Settings } from "../settings.ts";
import type { CliIO } from "./run.ts";

export const CONFIG_USAGE = `Usage: rlmh config list
       rlmh config get KEY
       rlmh config set KEY VALUE
`;

function usage(io: Pick<CliIO, "stderr">, text: string): number {
  io.stderr.write(`rlmh config: ${text}\n${CONFIG_USAGE}`);
  return 2;
}

export async function configCommand(argv: string[], io: Pick<CliIO, "stdout" | "stderr" | "home">): Promise<number> {
  const args = argv.filter((a) => a !== "--verbose");
  const [verb, ...rest] = args;
  const arity: Record<string, number> = { list: 0, get: 1, set: 2 };
  if (verb === undefined) return usage(io, "name list, get or set");
  if (!(verb in arity)) return usage(io, `unknown subcommand "${verb}"`);
  if (rest.length !== arity[verb]) return usage(io, `${verb} takes ${arity[verb] === 0 ? "no arguments" : arity[verb] === 1 ? "KEY" : "KEY VALUE"}`);

  let settings: Settings;
  try {
    settings = loadSettings(io.home);
  } catch (err) {
    io.stderr.write(`rlmh: ${(err as Error).message}\n`);
    return 1;
  }
  try {
    if (verb === "list") {
      io.stdout.write(listSettings(settings).map(([k, v]) => `${k} = ${v}\n`).join(""));
    } else if (verb === "get") {
      io.stdout.write(`${getSetting(settings, rest[0]!)}\n`);
    } else {
      const [key, value] = rest as [string, string];
      const next = setSetting(settings, key, value); // coerces the string to the key's type
      saveSettings(io.home, next);
      io.stdout.write(`${key} = ${getSetting(next, key)}\n`);
    }
  } catch (err) {
    if (err instanceof SettingsError) {
      io.stderr.write(`rlmh config: ${err.message}\n`);
      return 2;
    }
    io.stderr.write(`rlmh: ${(err as Error).message}\n`); // settings.toml could not be written
    return 1;
  }
  return 0;
}
