// KV cache: none; it only picks which level a request carries, the same level for the same model every time.
// Which thinking levels each model takes (D-250), and the level to send when a setting or a sub-call's `thinking=`
// names one the model lacks. OpenRouter lists each model's own levels (`reasoning.supported_efforts`), which a refresh
// keeps as `thinking_levels`; every other model goes by its provider's docs, read 2026-11-03, by model id.

import { THINKING_LEVELS, type Thinking } from "../protocol.ts";
import type { ModelInfo } from "./catalog.ts";
import { openRouterEndpoint } from "./providers.ts";

export type ThinkingOn = Exclude<Thinking, "off">;

/** The levels a model takes besides "off", least first, and how it reads the others (a provider's documented aliases). */
export interface ThinkingRule {
  levels: readonly ThinkingOn[];
  alias?: Partial<Record<ThinkingOn, ThinkingOn>>;
}

const ALL: ThinkingRule = { levels: THINKING_LEVELS.filter((l): l is ThinkingOn => l !== "off") };
const CLASSIC: ThinkingRule = { levels: ["low", "medium", "high"] };

/** Messages API effort: xhigh came with Opus 4.7, max with Opus 4.6; older models think by budget. By the id after `claude-`. */
function claude(name: string): ThinkingRule {
  if (/^(opus-4-[78]|opus-5|sonnet-5|haiku-5|fable-|mythos-)/.test(name)) return { levels: ["low", "medium", "high", "xhigh", "max"] };
  if (/^(opus|sonnet)-4-6/.test(name)) return { levels: ["low", "medium", "high", "max"] };
  return CLASSIC;
}

/** `reasoning_effort` by model (OpenAI's model pages and SDK docs); "none" is off. */
function openai(id: string): ThinkingRule {
  if (/^o\d/.test(id)) return CLASSIC;
  if (/^gpt-5-pro/.test(id)) return { levels: ["high"] };
  if (/^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/.test(id) || /^gpt-5-codex/.test(id)) return { levels: ["minimal", "low", "medium", "high"] };
  if (/^gpt-5\.1(-codex(-mini)?)?(-\d{4}-\d{2}-\d{2})?$/.test(id)) return CLASSIC;
  if (/^gpt-5\.\d/.test(id)) return { levels: ["low", "medium", "high", "xhigh"] };
  if (/^gpt-6/.test(id)) return { levels: ["low", "medium", "high", "xhigh", "max"] };
  return CLASSIC;
}

/** DeepSeek V4 and later: none, low, high, max; the API itself reads minimal as low and medium and xhigh as high. */
const DEEPSEEK: ThinkingRule = { levels: ["low", "high", "max"], alias: { minimal: "low", medium: "high", xhigh: "high" } };

/** Gemini's OpenAI-compatible `reasoning_effort`: minimal to high, except the Pro models of 3 and later (low to high). */
function gemini(id: string): ThinkingRule {
  if (/^gemini-3-pro-preview/.test(id)) return { levels: ["low", "high"] };
  if (/^gemini-[3-9][.\d]*-pro/.test(id)) return CLASSIC;
  return { levels: ["minimal", "low", "medium", "high"] };
}

/** xAI's Grok: 4.6 and later add xhigh. */
function grok(id: string): ThinkingRule {
  return /^grok-(4\.[6-9]|[5-9])/.test(id) ? { levels: ["low", "medium", "high", "xhigh"] } : CLASSIC;
}

/** The id after `claude-` (or `anthropic/claude-`), dots as dashes, date and `-latest` dropped; null for another model. */
function claudeName(model: string): string | null {
  const m = /^~?(?:anthropic\/)?claude-(.+)$/.exec(model);
  return m ? m[1]!.replace(/\./g, "-").replace(/(-\d{8})?(-latest)?$/, "") : null;
}

/** A model's own rule from its id, as its maker's API reads it. */
function byMaker(maker: string, id: string): ThinkingRule {
  const name = claudeName(id);
  if (maker === "anthropic" || name !== null) return claude(name ?? id);
  if (maker === "openai") return openai(id);
  if (maker === "deepseek" || /^deepseek/.test(id)) return DEEPSEEK;
  if (maker === "gemini" || maker === "google") return gemini(id);
  if (maker === "x-ai") return grok(id);
  return CLASSIC;
}

/** How a model thinks. A local or custom server's chat template decides for itself, and the fake ignores thinking, so
 *  every level goes through as asked; a model the catalog lists without reasoning takes none. */
export function thinkingRule(provider: string, model: string, info?: ModelInfo): ThinkingRule {
  if (provider === "local" || provider === "custom" || provider === "fake") return ALL;
  if (info !== undefined && !info.reasoning) return { levels: [] };
  if (provider !== "openrouter") return byMaker(provider, model);
  const id = openRouterEndpoint(model).model.replace(/^~/, "");
  const slash = id.indexOf("/");
  const rule = slash > 0 ? byMaker(id.slice(0, slash), id.slice(slash + 1)) : CLASSIC;
  return info?.thinking_levels && info.thinking_levels.length > 0 ? { levels: info.thinking_levels, ...(rule.alias ? { alias: rule.alias } : {}) } : rule;
}

/** The level to send. "off", a level the model takes, or a model with no levels known (the provider's 400 fallback then
 *  decides) goes as asked; else the provider's own alias, else the nearest level it takes, the lower one on a tie. */
export function fitThinking(level: Thinking, rule: ThinkingRule): Thinking {
  if (level === "off" || rule.levels.length === 0 || rule.levels.includes(level)) return level;
  const alias = rule.alias?.[level];
  if (alias !== undefined && rule.levels.includes(alias)) return alias;
  const rank = (l: Thinking) => THINKING_LEVELS.indexOf(l);
  let best = rule.levels[0]!;
  for (const l of rule.levels) if (Math.abs(rank(l) - rank(level)) < Math.abs(rank(best) - rank(level))) best = l;
  return best;
}

/** Parses OpenRouter's `reasoning.supported_efforts` (highest first, "none" for off) into levels, least first. */
export function levelsFromEfforts(efforts: unknown): ThinkingOn[] | undefined {
  if (!Array.isArray(efforts)) return undefined;
  const on = THINKING_LEVELS.filter((l): l is ThinkingOn => l !== "off" && efforts.includes(l));
  return on.length > 0 ? on : undefined;
}
