// KV cache: none; the interface never touches the bytes sent to the model.
// /model: the root and sub rows. Enter picks a provider, then a model (typing filters, and Enter
// on a typed id the catalog lacks takes it as written), then the thinking level. Each pick is
// saved through applySetting and applies to the next run.

import { useInput } from "ink";
import { useEffect, useState } from "react";
import type { ModelInfo } from "../../gateway/catalog.ts";
import { PROVIDERS } from "../../gateway/providers.ts";
import { SettingsError } from "../../settings.ts";
import { formatTokens } from "../format.ts";
import { applySetting, isActive } from "../store.ts";
import { paint, span, useTheme, type Line } from "../theme.ts";
import { fit, Frame, listLines } from "./common.tsx";
import type { ScreenProps } from "./index.ts";

type Role = "root" | "sub";
const THINKING = ["default", "off", "low", "medium", "high"] as const;
const SAME = "same as root";

type Step =
  | { step: "roles" }
  | { step: "provider"; role: Role }
  | { step: "model"; role: Role; provider: string; filter: string }
  | { step: "thinking"; role: Role; ref: string };

function price(m: ModelInfo): string {
  return `$${m.price.input}/$${m.price.output} per 1M`;
}

export function ModelScreen(props: ScreenProps) {
  const theme = useTheme();
  const { deps } = props;
  const env = deps.env ?? process.env;
  const [step, setStep] = useState<Step>({ step: "roles" });
  const [sel, setSel] = useState(0);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => setSel(0), [step.step]);

  const settings = deps.session.settings;
  const providers = [...(step.step === "provider" && step.role === "sub" ? [SAME] : []), ...PROVIDERS.filter((p) => p.id !== "fake" || env.RLMH_FAKE_SCRIPT).map((p) => p.id)];
  const models: { id: string; info?: ModelInfo }[] = [];
  if (step.step === "model") {
    const list = step.provider === "fake" ? [deps.catalog.get("fake", "scripted")!] : deps.catalog.models(step.provider);
    const f = step.filter.toLowerCase();
    for (const m of list) if (m.id.toLowerCase().includes(f) || m.name.toLowerCase().includes(f)) models.push({ id: m.id, info: m });
    if (step.filter && !models.some((m) => m.id === step.filter)) models.push({ id: step.filter });
  }

  const save = (pairs: [string, string][], note: string) => {
    try {
      for (const [k, v] of pairs) applySetting(deps, k, v);
      const runNote = isActive(props.view.phase) ? " It applies to the next run." : "";
      setMessage({ text: `${note}${runNote}`, error: false });
      setStep({ step: "roles" });
    } catch (err) {
      setMessage({ text: err instanceof SettingsError || err instanceof Error ? err.message : String(err), error: true });
    }
  };

  const count = step.step === "roles" ? 2 : step.step === "provider" ? providers.length : step.step === "model" ? models.length : THINKING.length;
  useInput(
    (input, key) => {
      if (key.escape) {
        if (step.step === "roles") props.close();
        else if (step.step === "provider") setStep({ step: "roles" });
        else if (step.step === "model") setStep({ step: "provider", role: step.role });
        else setStep({ step: "roles" });
        return;
      }
      if (key.upArrow) return setSel((s) => Math.max(0, s - 1));
      if (key.downArrow) return setSel((s) => Math.min(Math.max(0, count - 1), s + 1));
      if (key.return) {
        setMessage(null);
        if (step.step === "roles") setStep({ step: "provider", role: sel === 0 ? "root" : "sub" });
        else if (step.step === "provider") {
          const id = providers[sel]!;
          if (id === SAME) save([["sub.model", ""]], "The sub-call model is now the root model.");
          else setStep({ step: "model", role: step.role, provider: id, filter: "" });
        } else if (step.step === "model") {
          const m = models[sel];
          if (m) setStep({ step: "thinking", role: step.role, ref: `${step.provider}/${m.id}` });
        } else {
          const known = deps.catalog.get(...(splitRef(step.ref) as [string, string]));
          save(
            [
              [`${step.role}.model`, step.ref],
              [`${step.role}.thinking`, THINKING[sel]!],
            ],
            `${step.role} is ${step.ref}, thinking ${THINKING[sel]}.${known ? "" : " Window and prices unknown."}`,
          );
        }
        return;
      }
      if (step.step === "model") {
        if (key.backspace || key.delete) setStep({ ...step, filter: step.filter.slice(0, -1) });
        else if (!key.ctrl && !key.meta && input && !/[\s\u0000-\u001f]/.test(input)) setStep({ ...step, filter: step.filter + input });
        setSel(0);
      }
    },
    { isActive: props.active },
  );

  const w = props.width;
  const body: Line[] = [];
  const room = Math.max(1, props.height - 5);
  if (step.step === "roles") {
    const rows: Line[] = (["root", "sub"] as Role[]).map((r) => {
      const model = settings[r].model || (r === "sub" ? SAME : "none picked");
      return [span(fit(`${r.padEnd(5)} ${model}   thinking ${settings[r].thinking}`, w, theme))];
    });
    body.push(...listLines(rows, sel, 2, theme));
  } else if (step.step === "provider") {
    body.push([span(`Provider for ${step.role}`, { dim: true })]);
    body.push(...listLines(providers.map((p) => [span(fit(p === SAME ? SAME : `${p.padEnd(12)} ${PROVIDERS.find((d) => d.id === p)!.name}`, w, theme))]), sel, room, theme));
  } else if (step.step === "model") {
    body.push([span(`Model for ${step.role} from ${step.provider}; type to filter: `, { dim: true }), span(step.filter || " ", { inverse: true })]);
    const rows: Line[] = models.map((m) =>
      m.info ? [span(fit(`${m.id}   window ${formatTokens(m.info.context_window)}   ${price(m.info)}`, w, theme))] : [span(fit(`use "${m.id}" as typed (window and prices unknown)`, w, theme), { dim: true })],
    );
    if (rows.length === 0) body.push([span("  No models. Type an id to use it as written.", { dim: true })]);
    body.push(...listLines(rows, sel, room, theme));
  } else {
    body.push([span(`Thinking for ${step.role} ${step.ref}`, { dim: true })]);
    body.push(...listLines(THINKING.map((t) => [span(t)]), sel, room, theme));
  }
  if (message) body.push([], [span(fit(message.text, w, theme), { color: paint(theme, message.error ? "red" : "green") })]);
  return <Frame title="/model" hint="Up/Down  Enter chooses  Esc goes back" body={body} width={w} height={props.height} />;
}

function splitRef(ref: string): [string, string] {
  const at = ref.indexOf("/");
  return [ref.slice(0, at), ref.slice(at + 1)];
}
