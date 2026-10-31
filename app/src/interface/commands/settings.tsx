// KV cache: none; the interface never touches the bytes sent to the model.
// /settings: every row of the one schema that `rlmh config` uses, plus a base_url and
// max_in_flight pair per listed provider. Enum: Left/Right cycles. Bool: Space toggles. String and
// int: type, Enter. d resets to the default. Each change is saved at once; a validation error
// shows under the row and nothing is saved.

import { useInput } from "ink";
import { useEffect, useState } from "react";
import { PROVIDERS } from "../../gateway/providers.ts";
import { getSetting, SCHEMA, type SettingDef } from "../../settings.ts";
import { applySetting } from "../store.ts";
import { paint, span, useTheme, type Line } from "../theme.ts";
import { fit, Frame, listLines } from "./common.tsx";
import type { ScreenProps } from "./index.ts";

export interface SettingRow {
  key: string;
  def: SettingDef;
}

/** SCHEMA in order, with each `providers.<id>.*` template once per listed provider. */
export function settingRows(): SettingRow[] {
  const rows: SettingRow[] = [];
  for (const def of SCHEMA) {
    if (!def.key.startsWith("providers.<id>.")) rows.push({ key: def.key, def });
    else if (def.key === "providers.<id>.base_url") {
      for (const p of PROVIDERS) {
        if (p.id === "fake") continue;
        for (const d of SCHEMA.filter((s) => s.key.startsWith("providers.<id>."))) rows.push({ key: d.key.replace("<id>", p.id), def: d });
      }
    }
  }
  return rows;
}

export function SettingsScreen(props: ScreenProps) {
  const theme = useTheme();
  const { deps } = props;
  const rows = settingRows();
  const [sel, setSel] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const [profiles, setProfiles] = useState<string[] | null>(null);
  const [, redraw] = useState(0);
  useEffect(() => {
    let live = true;
    deps.session.info().then(
      (info) => live && setProfiles(info.profiles.map((p) => p.name)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [deps.session]);

  const row = rows[sel]!;
  const choices = row.key === "profile" ? profiles : row.def.type === "enum" ? row.def.choices! : null;
  const value = (key: string) => getSetting(deps.session.settings, key);
  const set = (key: string, v: unknown) => {
    try {
      applySetting(deps, key, v);
      setError(null);
      redraw((n) => n + 1);
      return true;
    } catch (err) {
      setError({ key, text: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };

  useInput(
    (input, key) => {
      if (editing !== null) {
        if (key.escape) setEditing(null);
        else if (key.return) {
          if (set(row.key, editing)) setEditing(null);
        } else if (key.backspace || key.delete) setEditing(editing.slice(0, -1));
        else if (!key.ctrl && !key.meta && input) setEditing(editing + input.replace(/[\u0000-\u001f\u007f]/g, ""));
        return;
      }
      if (key.escape) return props.close();
      if (key.upArrow) return setSel((s) => Math.max(0, s - 1));
      if (key.downArrow) return setSel((s) => Math.min(rows.length - 1, s + 1));
      if ((key.leftArrow || key.rightArrow) && choices && choices.length > 0) {
        const at = choices.indexOf(String(value(row.key)));
        const next = at < 0 ? (key.rightArrow ? 0 : choices.length - 1) : (at + (key.rightArrow ? 1 : choices.length - 1)) % choices.length;
        set(row.key, choices[next]);
      } else if (input === " " && row.def.type === "bool") {
        set(row.key, !value(row.key));
      } else if (key.return && (row.def.type === "string" || row.def.type === "int") && !(row.key === "profile" && profiles)) {
        setEditing(String(value(row.key)));
        setError(null);
      } else if (input === "d") {
        set(row.key, row.def.default);
      }
    },
    { isActive: props.active },
  );

  const w = props.width;
  const items: Line[] = rows.map((r) => {
    const shown = editing !== null && r === row ? `${editing}_` : JSON.stringify(value(r.key));
    return [span(fit(`${r.key.padEnd(32)} ${shown}`, w, theme))];
  });
  const listHeight = Math.max(1, props.height - 2 - 3);
  const body: Line[] = listLines(items, sel, listHeight);
  if (error?.key === row.key) {
    const at = body.findIndex((l) => l[0]?.text === ">");
    body.splice(at + 1, 0, [span(fit(`  ${error.text}`, w, theme), { color: paint(theme, "red") })]);
  }
  body.push([span(fit(`  ${row.def.doc}`, w, theme), { dim: true })]);
  const how = choices ? "Left/Right cycles" : row.def.type === "bool" ? "Space toggles" : "Enter edits";
  body.push([span(fit(`  ${how}; d resets to ${JSON.stringify(row.def.default)}`, w, theme), { dim: true })]);
  return <Frame title="/settings" hint={editing !== null ? "Enter saves  Esc cancels" : "Up/Down  Esc closes"} body={body} width={w} height={props.height} />;
}
