// KV cache: none
// The reward for read tasks: a port of training's rlm_rl/reward.py at RLM commit 705ebcf (D-189).
//
// Exact answers, calibrated partial credit for near misses (spec §3, H1, decision 1b). Ported: parse_number,
// normalize_entity, _normalize_item, normalize_set, set_f1, check_grading, near_miss_credit, strip_id_labels,
// score_answer and score_count for numbers, entities and lists; _GENERIC, normalize_text, GENERIC_ANSWERS, token_f1,
// _MONTH_NAMES, _MONTHS, _DAY_RE, _date, _NUMBER_UNIT_RE, _number_unit, _COUNTRY_NAMES, _COUNTRIES, same_answer and
// score_text for free text. Names keep training's, in camelCase. app/test/eval/reward-vectors.json holds training's
// own outputs for this file's inputs.
//
// Python's values, from JSON: a number with an integer value is an int and any other number a float (in JavaScript
// `5.0` is `5`, so an integral float reads as an int: the only place that differs is strip_id_labels, where Python's
// str(5.0) is "5.0"); true and false are bools; null is None; an array is a list; an object is a dict.
// Python's str methods and regular expressions are Unicode-aware on str, so they are spelled out here:
// - `\s`, `str.strip()` and `str.split()` use PY_SPACE (str.isspace: it has \x1c-\x1f and \x85, JavaScript's \s
//   has ﻿ instead);
// - `\w` is [\p{L}\p{N}_], `\b` before or after a word character is a lookaround on it, and `\d` is \p{Nd};
// - int() and float() read any decimal digit (pyDigits);
// - casefold() is casefold() below; round() is pyRound (correctly rounded, ties to even);
// - str() and repr() are pyStr and pyRepr.
// A code point Unicode added after 15.0 (Python 3.12's tables) can still read differently: Bun's are newer.

/** One answer's score: training's Score (`reward` is `score`, `correct` is `exact`), plus `f1` for text. */
export interface Score {
  score: number;
  exact: boolean;
  components: Record<string, number>;
  f1?: number;
}

/** What training's check_grading raises: the task can't be scored. */
export class GradingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GradingError";
  }
}

export const ANSWER_TYPES = ["int", "float", "entity", "list", "text", "count"] as const;
export const LIST_ITEM_TYPES = ["int", "float", "entity"] as const;

export const EXACT_REWARD = 1.0;
export const NEAR_MISS_MAX = 0.8;
// How fast near-miss credit falls, in units of the blind guess's error. 1 is the spec's formula: credit
// reaches 0 exactly at the blind guess's error (decision 1b, kept by decision 5b on 2026-10-11).
export const NEAR_MISS_SLOPE = 1.0;
export const DECIMAL_TOLERANCE = 0.005;
// The "count" type (aggregation-v3): OOLONG's near-miss credit, 0.75 per unit of error, scaled to NEAR_MISS_MAX.
// A miss of COUNT_MAX_ERR or more earns nothing: 0.8 x 0.75^10 = 0.045, under the 0.05 a metadata guess may earn,
// so this only trims a tail that was already below it.
export const COUNT_DECAY = 0.75;
export const COUNT_MAX_ERR = 10;
// aggregation-v4 counts over a whole log reach ~1,300, where a miss of a few lines is near-perfect labelling. A unit of
// error is COUNT_REL_UNIT of the gold count, at least 1, so counts up to 100 keep OOLONG's per-line credit exactly.
export const COUNT_REL_UNIT = 0.01;

// ----------------------------------------------------------------------------- Python's str, for this file

/** The characters Python's str.isspace() and re's `\s` accept, as a regex class body. */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** Python re's `\w` on str (alphanumerics and the underscore), as a regex class body. */
const PY_WORD = "\\p{L}\\p{N}_";
const SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, "u");
const SPACE_ONE = new RegExp(`[${PY_SPACE}]`, "u");

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python's str.split() with no argument: split on any run of whitespace, no empty parts. */
export function pySplit(text: string): string[] {
  return text.split(SPACE_RUN).filter((part) => part !== "");
}

/** Python's str.strip(chars): whitespace when `chars` is undefined. */
export function pyStrip(text: string, chars?: string): string {
  const drop = (ch: string): boolean => (chars === undefined ? SPACE_ONE.test(ch) : chars.includes(ch));
  const cps = Array.from(text);
  let start = 0;
  let end = cps.length;
  while (start < end && drop(cps[start]!)) start++;
  while (end > start && drop(cps[end - 1]!)) end--;
  return cps.slice(start, end).join("");
}

// Where lower, upper, then lower case differs from casefold() (checked over every code point Python 3.12 knows):
// casefold() keeps the dotless ı, and folds Cherokee to its capitals.
const CHEROKEE = "\\u13a0-\\u13f5\\u13f8-\\u13fd\\uab70-\\uabbf";
const CASEFOLD_RUN = new RegExp(`[^\\u0131${CHEROKEE}]+|[${CHEROKEE}]+`, "gu");
const CHEROKEE_RE = new RegExp(`^[${CHEROKEE}]`, "u");

/** Python's str.casefold(). JavaScript has none: lower, upper, then lower case gives the full folding (ß and ẞ to
 * ss, ſ to s, İ to i̇), except that lower case writes a final sigma as ς, which casefold() never does. */
export function casefold(text: string): string {
  return text.replace(CASEFOLD_RUN, (run) => (CHEROKEE_RE.test(run) ? run.toUpperCase()
    : run.toLowerCase().toUpperCase().toLowerCase().replaceAll("ς", "σ")));
}

const ND = /\p{Nd}/u;
const ND_ALL = /\p{Nd}/gu;

/** A decimal digit's value. Unicode keeps every decimal digit in runs of ten from 0 to 9. */
function digitValue(ch: string): number {
  let cp = ch.codePointAt(0)!;
  let run = 0;
  while (ND.test(String.fromCodePoint(cp - 1))) {
    cp--;
    run++;
  }
  return run % 10;
}

/** `text` with every decimal digit written in ASCII, as Python's int() and float() read them. */
function pyDigits(text: string): string {
  return text.replace(ND_ALL, (ch) => (ch >= "0" && ch <= "9" ? ch : String(digitValue(ch))));
}

// Characters str.isdigit() accepts that are not decimal digits (Numeric_Type=Digit), from Python 3.12's tables.
// int() refuses them.
const DIGIT_ONLY = new RegExp(
  "[\\u00b2\\u00b3\\u00b9\\u1369-\\u1371\\u19da\\u2070\\u2074-\\u2079\\u2080-\\u2089\\u2460-\\u2468\\u2474-\\u247c" +
    "\\u2488-\\u2490\\u24ea\\u24f5-\\u24fd\\u24ff\\u2776-\\u277e\\u2780-\\u2788\\u278a-\\u2792\\u{10a40}-\\u{10a43}" +
    "\\u{10e60}-\\u{10e68}\\u{11052}-\\u{1105a}\\u{1f100}-\\u{1f10a}]",
  "u",
);

/** Python's str.isdigit(). */
function isDigit(text: string): boolean {
  const cps = Array.from(text);
  return cps.length > 0 && cps.every((ch) => ND.test(ch) || DIGIT_ONLY.test(ch));
}

/** Python's int() on a string of digits: a non-decimal digit (str.isdigit's extras) raises, as it does in Python. */
function pyInt(text: string): number {
  if (!Array.from(text).every((ch) => ND.test(ch))) {
    const err = new Error(`invalid literal for int() with base 10: ${pyRepr(text)}`);
    err.name = "ValueError";
    throw err;
  }
  return Number(pyDigits(text));
}

/** Python's float() on a string the regexes here matched (digits, a point, a minus sign). */
function pyFloat(text: string): number {
  return Number(pyDigits(text));
}

/** Python's round(x, ndigits): the exact binary value rounded to `ndigits` places, ties to even. */
export function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp = -1074;
  if (biased !== 0) {
    mant |= 1n << 52n;
    exp = biased - 1075;
  }
  if (exp >= 0) return x;
  const num = mant * 10n ** BigInt(ndigits);
  const den = 1n << BigInt(-exp);
  let q = num / den;
  const twice = 2n * (num % den);
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  const out = Number(`${q}e-${ndigits}`);
  return x < 0 ? -out : out;
}

/** Python's repr() of a float that is not an integer: the shortest digits, fixed from 1e-4 to 1e16. */
function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const [mant, expText] = Math.abs(x).toExponential().split("e") as [string, string];
  const digits = mant.replace(".", "");
  const exp = Number(expText);
  const sign = x < 0 ? "-" : "";
  if (exp < -4 || exp >= 16) {
    const lead = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${lead}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  const whole = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
  return `${sign}${whole}.${digits.slice(exp + 1) || "0"}`;
}

const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Python's repr() of a str. */
function strRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\" || ch === quote) out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch !== " " && UNPRINTABLE.test(ch)) {
      out += cp < 0x100 ? `\\x${cp.toString(16).padStart(2, "0")}`
        : cp < 0x10000 ? `\\u${cp.toString(16).padStart(4, "0")}` : `\\U${cp.toString(16).padStart(8, "0")}`;
    } else out += ch;
  }
  return out + quote;
}

/** Python's str() of a value read from JSON. */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value).toString() : floatRepr(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === undefined) return "None";
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isDict(value)) return `{${Object.entries(value).map(([k, v]) => `${strRepr(k)}: ${pyRepr(v)}`).join(", ")}}`;
  return String(value);
}

/** Python's repr() of a value read from JSON. */
export function pyRepr(value: unknown): string {
  return typeof value === "string" ? strRepr(value) : pyStr(value);
}

/** Python's truth value of a value read from JSON. */
function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

// ----------------------------------------------------------------------------- parsing

// A minus sign counts only when it isn't joined to a word, so "host-42" parses as 42.
const NUMBER_RE = new RegExp(`(?:(?<![${PY_WORD}])-)?\\p{Nd}+(?:\\.\\p{Nd}+)?`, "u");
const QUOTES = "\"'`‘’“”";
const LIST_SPLIT_RE = /[,;\n]/;

/** The first number in an answer, after removing `$` and `,` (spec §3). None if there is none. */
export function parseNumber(value: unknown): number | null {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = NUMBER_RE.exec(value.replaceAll("$", "").replaceAll(",", ""));
  return match ? pyFloat(match[0]) : null;
}

/** Trim whitespace and quotes, ignore case. None for an empty answer or a list. */
export function normalizeEntity(value: unknown): string | null {
  if (typeof value === "boolean" || Array.isArray(value) || value === null || value === undefined) return null;
  // A float with an integer value prints as an int: pyStr does that.
  const text = casefold(pyStrip(pyStrip(pyStrip(pyStr(value)), QUOTES)));
  return text || null;
}

function normalizeItem(value: unknown, item: string): string | number | null {
  if (item === "entity") return normalizeEntity(value);
  const number = parseNumber(value);
  if (number === null) return null;
  return item === "float" ? pyRound(number, 2) : number;
}

/** A list answer as a set of normalized items. A string is split on commas, semicolons and newlines. */
export function normalizeSet(value: unknown, item: string): Set<string | number> {
  let values: unknown[];
  if (typeof value === "string") values = value.split(LIST_SPLIT_RE).filter((part) => pyStrip(part));
  else if (!Array.isArray(value)) values = [value];
  else values = value;
  const items = new Set<string | number>();
  for (const v of values) {
    const norm = normalizeItem(v, item);
    if (norm !== null) items.add(norm);
  }
  return items;
}

export function setF1(predicted: Set<string | number>, gold: Set<string | number>): number {
  if (!predicted.size && !gold.size) return 1.0;
  let hits = 0;
  for (const x of predicted) if (gold.has(x)) hits++;
  if (!hits) return 0.0;
  const precision = hits / predicted.size;
  const recall = hits / gold.size;
  return (2 * precision * recall) / (precision + recall);
}

function setsEqual(a: Set<string | number>, b: Set<string | number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ----------------------------------------------------------------------------- scoring

function tupleRepr(items: readonly string[]): string {
  return `(${items.map(pyRepr).join(", ")})`;
}

function getKey(grading: Record<string, unknown>, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(grading, key) ? grading[key] : fallback;
}

/** Raise GradingError if a task can't be scored. Every number or list task must carry its blind guess. */
function checkGradingOrRaise(grading: Record<string, unknown>, gold: unknown): void {
  const kind = getKey(grading, "type");
  if (typeof kind !== "string" || !(ANSWER_TYPES as readonly string[]).includes(kind)) {
    throw new GradingError(`unknown answer type ${pyRepr(kind)}`);
  }
  if ((kind === "int" || kind === "float" || kind === "count")
    && (parseNumber(gold) === null || parseNumber(getKey(grading, "blind")) === null)) {
    throw new GradingError(`a ${kind} task needs a numeric gold answer and a numeric blind guess`);
  }
  if (kind === "list") {
    const item = getKey(grading, "item");
    if (typeof item !== "string" || !(LIST_ITEM_TYPES as readonly string[]).includes(item)) {
      throw new GradingError(`a list task needs an item type in ${tupleRepr(LIST_ITEM_TYPES)}`);
    }
    if (!Array.isArray(gold) || !Array.isArray(getKey(grading, "blind"))) {
      throw new GradingError("a list task needs a list gold answer and a list blind guess");
    }
  }
  if (kind === "entity" && normalizeEntity(gold) === null) {
    throw new GradingError("an entity task needs a non-empty gold answer");
  }
  if (kind === "text" && (normalizeText(gold) === null || !Array.isArray(getKey(grading, "aliases", []))
    || getKey(grading, "blind") !== null)) {
    throw new GradingError("a text task needs a non-empty gold answer, a list of aliases and no blind guess");
  }
}

/** training's check_grading as a list of problems: empty when the task can be scored, else the one it raises. */
export function checkGrading(grading: unknown, gold?: unknown): string[] {
  if (!isDict(grading)) return [`grading must be an object, not ${pyRepr(grading)}`];
  try {
    checkGradingOrRaise(grading, gold ?? null);
    return [];
  } catch (err) {
    if (err instanceof GradingError) return [err.message];
    throw err;
  }
}

/** 0.8 x max(0, 1 - err / e_blind). If the blind guess was exact (e_blind = 0), a near miss earns 0. */
export function nearMissCredit(err: number, eBlind: number): number {
  if (eBlind <= 0) return 0.0;
  return NEAR_MISS_MAX * Math.min(1.0, Math.max(0.0, 1.0 - (NEAR_MISS_SLOPE * err) / eBlind));
}

function unparsed(): Record<string, number> {
  return { parsed: 0.0, exact: 0.0, partial: 0.0 };
}

// Ids in a list answer ("11952", or pairs "11952|62016"): an item may carry the log's own label, "user 11952" or
// "user#11952". prod-v2 steps 1-11: 12 of 166 context-search episodes had the right set written that way and scored 0,
// the same as a wrong count, so the reward couldn't tell a format slip from a counting error.
const ID_ITEM_RE = /^\p{Nd}+(?:\|\p{Nd}+)*$/u;
// Python's IGNORECASE also lets ſ stand for s, and İ and ı for i: spelled out, since JavaScript's folding has only ſ.
const ID_LABEL_RE = new RegExp(
  `(?<![${PY_WORD}])(?:u[sſ]er|[iİı]d)[${PY_SPACE}]*#?[${PY_SPACE}]*(?=\\p{Nd})|#(?=\\p{Nd})`,
  "giu",
);
const PIPE_SPACE_RE = new RegExp(`[${PY_SPACE}]*\\|[${PY_SPACE}]*`, "gu");

/** `answer` with "user"/"user#"/"id"/"#" labels removed before each id, when every gold item is an id or a
 * pair of ids; any other answer is returned as it is. */
export function stripIdLabels(answer: unknown, gold: unknown): unknown {
  const golds = Array.isArray(gold) ? gold : [gold];
  if (!golds.length || !golds.every((g) => ID_ITEM_RE.test(pyStrip(pyStr(g))))) return answer;
  const clean = (v: unknown): unknown =>
    typeof v === "string" ? v.replace(ID_LABEL_RE, "").replace(PIPE_SPACE_RE, "|") : v;
  return Array.isArray(answer) ? answer.map(clean) : clean(answer);
}

/** Score one answer (spec §3 steps 1-3). `answer` is None (null or undefined) when nothing valid was submitted.
 * Throws GradingError for a grading checkGrading refuses. */
export function scoreAnswer(answer: unknown, gold: unknown, grading: Record<string, unknown>): Score {
  if (!isDict(grading)) throw new GradingError(`grading must be an object, not ${pyRepr(grading)}`);
  gold = gold ?? null;
  checkGradingOrRaise(grading, gold);
  const kind = grading["type"] as string;
  if (answer === null || answer === undefined) return { score: 0.0, exact: false, components: unparsed() };

  if (kind === "count") return scoreCount(answer, gold, grading);

  if (kind === "int" || kind === "float") {
    const value = parseNumber(answer);
    const target = parseNumber(gold)!;
    const blind = parseNumber(grading["blind"])!;
    if (value === null) return { score: 0.0, exact: false, components: unparsed() };
    const err = Math.abs(value - target);
    const eBlind = Math.abs(blind - target);
    const exact = kind === "int" ? value === target : err <= DECIMAL_TOLERANCE + 1e-9;
    const partial = exact ? 0.0 : pyRound(nearMissCredit(err, eBlind), 4);
    // A wrong answer nearer the blind guess than the gold looks like guessing from metadata. Logged only,
    // never part of the reward: if its rate climbs, the policy is drifting toward the guess.
    const nearBlind = Number(!exact && Math.abs(value - blind) < err);
    return {
      score: exact ? EXACT_REWARD : partial, exact,
      components: { parsed: 1.0, exact: Number(exact), partial, err, e_blind: eBlind, near_blind: nearBlind },
    };
  }

  if (kind === "text") return scoreText(answer, gold, grading);

  if (kind === "entity") {
    const value = normalizeEntity(answer);
    if (value === null) return { score: 0.0, exact: false, components: unparsed() };
    const exact = value === normalizeEntity(gold);
    return { score: exact ? EXACT_REWARD : 0.0, exact, components: { parsed: 1.0, exact: Number(exact), partial: 0.0 } };
  }

  const item = grading["item"] as string;
  const predicted = normalizeSet(stripIdLabels(answer, gold), item);
  const target = normalizeSet(gold, item);
  if (!predicted.size && target.size) return { score: 0.0, exact: false, components: unparsed() };
  const exact = setsEqual(predicted, target);
  const f1 = setF1(predicted, target);
  const f1Blind = setF1(normalizeSet(grading["blind"], item), target);
  const partial = exact ? 0.0 : pyRound(nearMissCredit(1 - f1, 1 - f1Blind), 4);
  return {
    score: exact ? EXACT_REWARD : partial, exact,
    components: { parsed: 1.0, exact: Number(exact), partial, f1: pyRound(f1, 4), f1_blind: pyRound(f1Blind, 4) },
  };
}

// ----------------------------------------------------------------------------- free text (the research family)

// Answers that say nothing. They earn 0, even when a token overlaps the gold (normalized below).
const GENERIC = ["unknown", "none", "N/A", "NA", "nan", "null", "nothing", "no answer", "not found", "not known",
  "not available", "not stated", "not mentioned", "not given", "not specified", "no idea", "I don't know",
  "I do not know", "cannot be determined", "can't be determined", "unanswerable", "insufficient information",
  "not enough information", "answer", "final answer"];

const MN = /\p{Mn}/u;
const PD_ZS = /[\p{Pd}\p{Zs}]/u;
const P_S = /[\p{P}\p{S}]/u;
const ARTICLE_RE = new RegExp(`(?<![${PY_WORD}])(?:a|an|the)(?![${PY_WORD}])`, "gu");

/** SQuAD-style: casefold, drop accents, the articles a/an/the and punctuation (a dash or slash becomes a space),
 * collapse whitespace. None for an empty answer, a list or a bool. */
export function normalizeText(value: unknown): string | null {
  if (typeof value === "boolean" || Array.isArray(value) || isDict(value) || value === null || value === undefined) {
    return null;
  }
  // A float with an integer value prints as an int: pyStr does that.
  const out: string[] = [];
  for (const ch of casefold(pyStr(value)).normalize("NFKD")) {
    if (MN.test(ch)) continue; // an accent
    out.push(PD_ZS.test(ch) || ch === "/" || ch === "\\" ? " " : P_S.test(ch) ? "" : ch);
  }
  const text = out.join("").replace(ARTICLE_RE, " ");
  return pySplit(text).join(" ") || null;
}

export const GENERIC_ANSWERS: ReadonlySet<string | null> = new Set(GENERIC.map(normalizeText));

/** Token F1 (SQuAD), with the tokens in `ignore` (the question's own words) left out of both sides, unless that
 * would leave the gold empty. */
export function tokenF1(predicted: string[], gold: string[], ignore: ReadonlySet<unknown> = new Set()): number {
  const kept = gold.filter((t) => !ignore.has(t));
  if (kept.length) {
    gold = kept;
    predicted = predicted.filter((t) => !ignore.has(t));
  }
  const counts = new Map<string, number>();
  for (const t of gold) counts.set(t, (counts.get(t) ?? 0) + 1);
  let same = 0;
  for (const t of predicted) {
    const left = counts.get(t) ?? 0;
    if (left > 0) {
      same++;
      counts.set(t, left - 1);
    }
  }
  if (!same) return 0.0;
  const precision = same / predicted.length;
  const recall = same / gold.length;
  return (2 * precision * recall) / (precision + recall);
}

// Equivalent forms (research-v3, 2026-10-18). The pilot scored "Italy" 0 against a gold "Italian Republic" that had
// no aliases. MuSiQue's golds come in one form each, so a date, a number with a unit and a country name are each
// compared through a canonical form.
const MONTH_NAMES: readonly (readonly string[])[] = [["january", "jan"], ["february", "feb"], ["march", "mar"],
  ["april", "apr"], ["may"], ["june", "jun"], ["july", "jul"], ["august", "aug"], ["september", "sep", "sept"],
  ["october", "oct"], ["november", "nov"], ["december", "dec"]];
const MONTHS = new Map<string, number>(MONTH_NAMES.flatMap((names, i) => names.map((name) => [name, i + 1] as const)));
const DAY_RE = /^(\p{Nd}{1,2})(?:st|nd|rd|th)?$/u;
// A number alone, or followed by a unit: lowercase words with no digit ("53 member states", "3.5 km", "12%"). A
// capitalized word after it is a name ("3 Doors Down", "50 Cent"), not a unit.
const NUMBER_UNIT_RE = new RegExp(
  `^[${PY_SPACE}]*\\$?[${PY_SPACE}]*(-?(?:\\p{Nd}{1,3}(?:,\\p{Nd}{3})+|\\p{Nd}+)(?:\\.\\p{Nd}+)?)[${PY_SPACE}]*` +
    `(%|[a-z][^\\p{Nd}A-Z]*?)?[${PY_SPACE}]*\\.?[${PY_SPACE}]*$`,
  "u",
);
// A country's common name, then its official and other usual names.
const COUNTRY_NAMES: readonly (readonly string[])[] = [
  ["italy", "italian republic"], ["france", "french republic"], ["germany", "federal republic of germany"],
  ["united states", "united states of america", "usa", "us", "u.s.", "u.s.a."],
  ["united kingdom", "uk", "u.k.", "great britain", "britain",
    "united kingdom of great britain and northern ireland"],
  ["china", "people's republic of china", "prc"], ["russia", "russian federation"], ["spain", "kingdom of spain"],
  ["india", "republic of india"], ["ireland", "republic of ireland", "éire"],
  ["netherlands", "kingdom of the netherlands", "holland"], ["czech republic", "czechia"],
  ["iran", "islamic republic of iran"], ["mexico", "united mexican states"],
  ["brazil", "federative republic of brazil"], ["australia", "commonwealth of australia"],
  ["soviet union", "ussr", "union of soviet socialist republics"], ["myanmar", "burma"],
  ["ivory coast", "côte d'ivoire"], ["east timor", "timor-leste"], ["turkey", "türkiye", "republic of turkey"],
  ["egypt", "arab republic of egypt"], ["philippines", "republic of the philippines"],
  ["south africa", "republic of south africa"], ["poland", "republic of poland"],
  ["portugal", "portuguese republic"], ["greece", "hellenic republic"], ["austria", "republic of austria"],
  ["switzerland", "swiss confederation"], ["sweden", "kingdom of sweden"], ["norway", "kingdom of norway"],
  ["denmark", "kingdom of denmark"], ["belgium", "kingdom of belgium"], ["argentina", "argentine republic"],
  ["vietnam", "viet nam", "socialist republic of vietnam"], ["south korea", "republic of korea"],
  ["north korea", "democratic people's republic of korea", "dprk"], ["japan", "state of japan"],
  ["saudi arabia", "kingdom of saudi arabia"], ["israel", "state of israel"], ["finland", "republic of finland"],
  ["indonesia", "republic of indonesia"], ["pakistan", "islamic republic of pakistan"],
  ["bangladesh", "people's republic of bangladesh"], ["nigeria", "federal republic of nigeria"],
  ["kenya", "republic of kenya"], ["chile", "republic of chile"], ["colombia", "republic of colombia"],
  ["peru", "republic of peru"], ["venezuela", "bolivarian republic of venezuela"], ["cuba", "republic of cuba"],
  ["syria", "syrian arab republic"], ["laos", "lao people's democratic republic"],
  ["bolivia", "plurinational state of bolivia"], ["tanzania", "united republic of tanzania"],
  ["united arab emirates", "uae"], ["north macedonia", "macedonia", "republic of macedonia"],
];
const COUNTRIES = new Map<string | null, string>(
  COUNTRY_NAMES.flatMap((names) => names.map((name) => [normalizeText(name), names[0]!] as const)),
);

type DateTuple = readonly [number, number, number];

/** A normalized answer that is one whole date, as (year, month, day), day 0 for a month and year:
 * "29 march 2004", "29th of march 2004", "march 29 2004", "2004 03 29" (from 2004-03-29), "march 2004". */
function date(norm: string): DateTuple | null {
  let t = pySplit(norm);

  const day = (x: string): number | null => {
    const m = DAY_RE.exec(x);
    return m && 1 <= pyInt(m[1]!) && pyInt(m[1]!) <= 31 ? pyInt(m[1]!) : null;
  };

  const year = (x: string): number | null => (/^\p{Nd}{3,4}$/u.test(x) ? pyInt(x) : null);

  if (t.length === 4 && t[1] === "of") t = [t[0]!, t[2]!, t[3]!];
  if (t.length === 3) {
    for (const [d, m, y] of [[t[0]!, t[1]!, t[2]!], [t[1]!, t[0]!, t[2]!]] as const) {
      if (day(d) && MONTHS.has(m) && year(y)) return [year(y)!, MONTHS.get(m)!, day(d)!];
    }
    if (/^\p{Nd}{4}$/u.test(t[0]!) && isDigit(t[1]!) && isDigit(t[2]!) && 1 <= pyInt(t[1]!) && pyInt(t[1]!) <= 12
      && 1 <= pyInt(t[2]!) && pyInt(t[2]!) <= 31) {
      return [pyInt(t[0]!), pyInt(t[1]!), pyInt(t[2]!)];
    }
  }
  if (t.length === 2 && MONTHS.has(t[0]!) && year(t[1]!)) return [year(t[1]!)!, MONTHS.get(t[0]!)!, 0];
  return null;
}

/** An answer that is one number, alone or with a unit: (the number, whether a unit follows). None otherwise. */
function numberUnit(value: unknown): readonly [number, boolean] | null {
  if (typeof value === "boolean" || value === null || value === undefined || Array.isArray(value) || isDict(value)) {
    return null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? [value, false] : null;
  const m = NUMBER_UNIT_RE.exec(pyStr(value));
  if (!m) return null;
  return [pyFloat(m[1]!.replaceAll(",", "")), Boolean(pyStrip(m[2] ?? ""))];
}

/** Whether two answers are the same in different forms: one date in two formats, a number with and without its
 * unit ("53 member states" and 53), or a country's common and official names ("Italy", "Italian Republic"). */
export function sameAnswer(answer: unknown, gold: unknown): boolean {
  const a = normalizeText(answer);
  const g = normalizeText(gold);
  if (a === null || g === null) return false;
  if (a === g) return true;
  const da = date(a);
  const dg = date(g);
  if (da !== null || dg !== null) {
    return da !== null && dg !== null && da[0] === dg[0] && da[1] === dg[1] && da[2] === dg[2];
  }
  const na = numberUnit(answer);
  const ng = numberUnit(gold);
  if (na !== null && ng !== null && na[0] === ng[0] && !(na[1] && ng[1])) return true;
  return COUNTRIES.get(a) !== undefined && COUNTRIES.get(a) === COUNTRIES.get(g);
}

/** Python's frozenset(grading.get("ignore") or ()). */
function ignoreSet(value: unknown): Set<unknown> {
  if (!pyTruthy(value)) return new Set();
  if (typeof value === "string") return new Set(Array.from(value));
  if (isDict(value)) return new Set(Object.keys(value));
  if (Array.isArray(value)) {
    for (const v of value) {
      if (Array.isArray(v) || isDict(v)) throw new TypeError(`unhashable type: '${Array.isArray(v) ? "list" : "dict"}'`);
    }
    return new Set(value);
  }
  throw new TypeError(`'${typeof value === "number" ? (Number.isInteger(value) ? "int" : "float") : "bool"}' object is not iterable`);
}

/** A free-text answer: 1 for a normalized exact match with the gold or an alias, or the same answer in another
 * form (`sameAnswer`), else 0.8 x the best token-F1 against them, with the question's own words
 * (grading["ignore"]) left out. An empty or generic answer earns 0. */
export function scoreText(answer: unknown, gold: unknown, grading: Record<string, unknown>): Score {
  const value = normalizeText(answer);
  const forms = [gold, ...(getKey(grading, "aliases", []) as unknown[])];
  const golds = forms.map(normalizeText).filter((g): g is string => Boolean(g));
  if (value === null || (GENERIC_ANSWERS.has(value) && !golds.includes(value))) {
    return { score: 0.0, exact: false, components: unparsed() };
  }
  if (golds.includes(value) || forms.some((x) => sameAnswer(answer, x))) {
    return { score: EXACT_REWARD, exact: true, components: { parsed: 1.0, exact: 1.0, partial: 0.0, f1: 1.0 }, f1: 1.0 };
  }
  const ignore = ignoreSet(getKey(grading, "ignore"));
  const f1 = Math.max(...golds.map((g) => tokenF1(pySplit(value), pySplit(g), ignore)));
  const partial = pyRound(NEAR_MISS_MAX * f1, 4);
  const f1r = pyRound(f1, 4);
  return { score: partial, exact: false, components: { parsed: 1.0, exact: 0.0, partial, f1: f1r }, f1: f1r };
}

/** A count, OOLONG-style: exact 1, a miss 0.8 x 0.75^units, and 0 from COUNT_MAX_ERR units off, where a unit is
 * one, or 1% of a gold count over 100. The blind guess
 * doesn't scale the credit here; it is only logged (`e_blind`, `near_blind`), as for the "int" type. */
export function scoreCount(answer: unknown, gold: unknown, grading: Record<string, unknown>): Score {
  const value = parseNumber(answer);
  const target = parseNumber(gold)!;
  const blind = parseNumber(grading["blind"])!;
  if (value === null) return { score: 0.0, exact: false, components: unparsed() };
  const err = Math.abs(value - target);
  const eBlind = Math.abs(blind - target);
  const exact = value === target;
  const units = err / Math.max(1.0, COUNT_REL_UNIT * Math.abs(target));
  const partial = exact || units >= COUNT_MAX_ERR ? 0.0 : pyRound(NEAR_MISS_MAX * COUNT_DECAY ** units, 4);
  const nearBlind = Number(!exact && Math.abs(value - blind) < err);
  return {
    score: exact ? EXACT_REWARD : partial, exact,
    components: { parsed: 1.0, exact: Number(exact), partial, err, e_blind: eBlind, near_blind: nearBlind },
  };
}
