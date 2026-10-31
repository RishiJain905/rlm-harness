// KV cache: none; the interface never touches the bytes sent to the model.
// /providers: every provider in PROVIDERS (the fake is hidden) with its saved keys. Inside one:
// a adds, d deletes, s sets the active key, r refreshes models. Saving a key makes no request: the
// format check is local, and the key lives only in the field's state until keys.add takes it. The
// only network call here is r, one gateway.refreshModels, on that key press.

import { useInput, usePaste } from "ink";
import { useCallback, useEffect, useState } from "react";
import type { KeyInfo } from "../../gateway/keys.ts";
import { checkFormat } from "../../gateway/keys.ts";
import { PROVIDERS, type ProviderDef } from "../../gateway/providers.ts";
import { getSetting } from "../../settings.ts";
import { paint, span, useTheme, type Line } from "../theme.ts";
import { fit, Frame, listLines } from "./common.tsx";
import type { ScreenProps } from "./index.ts";

const LISTED = PROVIDERS.filter((p) => p.id !== "fake");

type Step =
  | { step: "list" }
  | { step: "provider"; id: string }
  | { step: "key"; id: string }
  | { step: "label"; id: string }
  | { step: "delete"; id: string; key: KeyInfo };

/** The variable a key would come from, by KeyStore.resolve's rule: the provider's, then its fallback, non-empty. */
export function envKeyVar(def: ProviderDef, env: Record<string, string | undefined>): string | null {
  for (const name of [def.envVar, def.envFallback]) if (name && env[name]?.trim()) return name;
  return null;
}

/** A pasted or typed key: control characters ignored, CR, LF and spaces stripped. */
function keyText(text: string): string {
  return text.replace(/[\u0000- \u007f]/g, "");
}

export function ProvidersScreen(props: ScreenProps) {
  const theme = useTheme();
  const { deps } = props;
  const env = deps.env ?? process.env;
  const [step, setStep] = useState<Step>({ step: "list" });
  const [sel, setSel] = useState(0);
  const [keySel, setKeySel] = useState(0);
  const [saved, setSaved] = useState<KeyInfo[]>([]);
  // the key being typed lives only here, and is cleared as soon as keys.add has it
  const [field, setField] = useState("");
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "error" | "info" } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    deps.keys.list().then(setSaved, (err: unknown) => setMessage({ text: String(err instanceof Error ? err.message : err), tone: "error" }));
  }, [deps.keys]);
  useEffect(reload, [reload]);

  const def = step.step === "list" ? LISTED[sel]! : LISTED.find((p) => p.id === step.id)!;
  const mine = saved.filter((k) => k.provider === def.id);
  const host = (): string => {
    const url = def.baseUrl ?? String(getSetting(deps.session.settings, `providers.${def.id}.base_url`));
    try {
      return new URL(url).host || url;
    } catch {
      return "(no base URL set)";
    }
  };

  const act = (what: Promise<unknown>, ok: string) => {
    setBusy(true);
    what.then(
      () => setMessage({ text: ok, tone: "ok" }),
      (err: unknown) => setMessage({ text: err instanceof Error ? err.message : String(err), tone: "error" }),
    ).finally(() => {
      setBusy(false);
      reload();
    });
  };

  const addKey = () => {
    const value = field;
    const name = label;
    setField("");
    setLabel("");
    setStep({ step: "provider", id: def.id });
    act(deps.keys.add(def.id, value, name), "Saved. Nothing was sent anywhere.");
  };

  const refresh = () => {
    setBusy(true);
    setMessage({ text: `Refreshing ${def.name} models...`, tone: "info" });
    deps.session.gateway.refreshModels(def.id).then(
      (models) => {
        try {
          deps.catalog.merge(def.id, models);
          setMessage({ text: `Refreshed: ${models.length} models from ${def.name}.`, tone: "ok" });
        } catch (err) {
          setMessage({ text: err instanceof Error ? err.message : String(err), tone: "error" });
        }
        setBusy(false);
      },
      (err: unknown) => {
        setMessage({ text: err instanceof Error ? err.message : String(err), tone: "error" });
        setBusy(false);
      },
    );
  };

  useInput(
    (input, key) => {
      if (step.step === "key" || step.step === "label") {
        if (key.escape) {
          setField("");
          setLabel("");
          setStep({ step: "provider", id: def.id });
          setMessage(null);
        } else if (key.return) {
          if (step.step === "key") {
            const problem = checkFormat(def.id, field);
            if (problem) setMessage({ text: problem, tone: "error" });
            else {
              setMessage(null);
              setStep({ step: "label", id: def.id });
            }
          } else addKey();
        } else if (key.backspace || key.delete) {
          if (step.step === "key") setField((f) => f.slice(0, -1));
          else setLabel((l) => l.slice(0, -1));
        } else if (!key.ctrl && !key.meta && input) {
          if (step.step === "key") setField((f) => f + keyText(input));
          else setLabel((l) => l + input.replace(/[\u0000-\u001f\u007f]/g, ""));
        }
        return;
      }
      if (step.step === "delete") {
        if (input === "y") act(deps.keys.remove(def.id, step.key.id), `Deleted ${step.key.label}.`);
        else setMessage(null);
        setStep({ step: "provider", id: def.id });
        return;
      }
      if (step.step === "list") {
        if (key.escape) props.close();
        else if (key.upArrow) setSel((s) => Math.max(0, s - 1));
        else if (key.downArrow) setSel((s) => Math.min(LISTED.length - 1, s + 1));
        else if (key.return) {
          setStep({ step: "provider", id: def.id });
          setKeySel(0);
          setMessage(null);
        }
        return;
      }
      // inside a provider
      const chosen = mine[Math.min(keySel, mine.length - 1)];
      if (key.escape) {
        setStep({ step: "list" });
        setMessage(null);
      } else if (key.upArrow) setKeySel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setKeySel((s) => Math.min(Math.max(0, mine.length - 1), s + 1));
      else if (busy) return;
      else if (input === "a") {
        setField("");
        setMessage(null);
        setStep({ step: "key", id: def.id });
      } else if (input === "d" && chosen) {
        setMessage({ text: `Delete ${chosen.label}${chosen.last4 ? ` (...${chosen.last4})` : ""}? y/N`, tone: "info" });
        setStep({ step: "delete", id: def.id, key: chosen });
      } else if (input === "s" && chosen) act(deps.keys.setActive(def.id, chosen.id), `${chosen.label} is the active key.`);
      else if (input === "r") refresh();
    },
    { isActive: props.active },
  );
  usePaste(
    (text) => {
      if (step.step === "key") setField((f) => f + keyText(text));
      else if (step.step === "label") setLabel((l) => l + text.replace(/[\u0000-\u001f\u007f]/g, ""));
    },
    { isActive: props.active && (step.step === "key" || step.step === "label") },
  );

  const w = props.width;
  const body: Line[] = [];
  const room = Math.max(1, props.height - 6);
  if (step.step === "list") {
    const rows: Line[] = LISTED.map((p) => {
      const keys = saved.filter((k) => k.provider === p.id);
      const active = keys.find((k) => k.active);
      const envVar = envKeyVar(p, env);
      const parts = [p.name.padEnd(16), `${keys.length} key${keys.length === 1 ? "" : "s"}`.padEnd(8)];
      if (active) parts.push(`active ${active.last4 ? `...${active.last4} ` : ""}(${active.label})`);
      if (envVar) parts.push(`key from ${envVar}`);
      if (!p.needsKey) parts.push(p.baseUrl ?? String(getSetting(deps.session.settings, `providers.${p.id}.base_url`) || "no base URL set"));
      return [span(fit(parts.join("  "), w, theme))];
    });
    body.push(...listLines(rows, sel, room, theme));
  } else {
    const envVar = envKeyVar(def, env);
    body.push([span(def.name, { bold: true }), span(`  ${def.needsKey ? "needs a key" : `base URL ${def.baseUrl ?? (String(getSetting(deps.session.settings, `providers.${def.id}.base_url`)) || "not set")}`}`, { dim: true })]);
    if (envVar) body.push([span(fit(`  key from ${envVar} (it wins over saved keys)`, w, theme), { color: paint(theme, "cyan") })]);
    if (mine.length === 0) body.push([span("  No saved keys.", { dim: true })]);
    const rows: Line[] = mine.map((k) => [span(fit(`${k.active ? theme.on : theme.off} ${k.label.padEnd(16)} ${k.last4 ? `...${k.last4}` : "       "}  ${k.store}  added ${k.created_at.slice(0, 10)}`, w, theme))]);
    body.push(...listLines(rows, Math.min(keySel, Math.max(0, mine.length - 1)), Math.max(1, room - 2), theme));
    body.push([span(fit(`r refreshes models: sends one request to ${host()} with the active key`, w, theme), { dim: true })]);
    if (step.step === "key") body.push([], [span("Key: ", { bold: true }), span(`${"*".repeat(Math.min(field.length, Math.max(0, w - 30)))}`), span(` (${field.length} characters)`, { dim: true })]);
    if (step.step === "label") body.push([], [span("Label (optional): ", { bold: true }), span(fit(`${label}_`, w - 20, theme))]);
  }
  if (message) body.push([span(fit(message.text, w, theme), { color: message.tone === "info" ? undefined : paint(theme, message.tone === "ok" ? "green" : "red") })]);
  const hint =
    step.step === "list"
      ? "Up/Down  Enter opens  Esc closes"
      : step.step === "key"
        ? "Paste or type the key, Enter  Esc cancels"
        : step.step === "label"
          ? "Enter saves  Esc cancels"
          : step.step === "delete"
            ? "y deletes, anything else keeps it"
            : "a add  d delete  s set active  r refresh models  Esc back";
  return <Frame title="/providers" hint={hint} body={body} width={w} height={props.height} />;
}
