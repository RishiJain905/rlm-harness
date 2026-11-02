// KV cache: none
// The JUnit half of training's repo grader, ported from `rlm_rl/grader.py` in RishiJain905/rlm (last changed
// at commit 55e2d62, read at dev_rishi's tip 042e486): `_junit_cases`, `_merge`, `pytest_key` and the rule
// `score` uses to decide "resolved". `junit-vectors.json` holds inputs and outputs that training's own functions
// produced, and `test/eval/junit.test.ts` checks this file against them.
//
// Training reads a pytest xunit1 report with ElementTree. This file has a small XML reader of its own instead of
// a dependency: elements, attributes, entities, CDATA, comments, processing instructions, a DOCTYPE (skipped)
// and XML namespaces, as strict as expat is about the things a report can get wrong. Entities a DOCTYPE declares
// are not supported (an `&name;` it defined is an error here), and the root must be `testsuites`, `testsuite` or
// `testcase`. `playwrightKey` has no training twin: it is our own rule (D-184).

export type TestStatus = "passed" | "failed" | "error" | "skipped";

/** What a keying function sees of one `<testcase>`. */
export interface JunitCase {
  /** The `file` attribute, which pytest writes under `junit_family=xunit1`; null when absent. */
  file: string | null;
  classname: string;
  name: string;
}

/** A report that is not well-formed XML, not a JUnit report, or that lists one test with outcomes that cannot merge. */
export class JunitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JunitError";
  }
}

// ----------------------------------------------------------------------------------------- the XML reader

interface RawCase {
  attrs: Map<string, string>;
  failure: boolean;
  error: boolean;
  skipped: boolean;
}

interface Frame {
  name: string;
  /** The element's name when it is in no namespace, else null (ElementTree names those `{uri}name`). */
  tag: string | null;
  ns: Map<string, string> | null;
  testcase: RawCase | null;
}

const NAME = /[\p{L}_:][\p{L}\p{N}_:.\-·\p{M}‿⁀]*/uy;
const XML_DECL =
  /<\?xml[ \t\n]+version[ \t\n]*=[ \t\n]*(?:"1\.[0-9]+"|'1\.[0-9]+')(?:[ \t\n]+encoding[ \t\n]*=[ \t\n]*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:[ \t\n]+standalone[ \t\n]*=[ \t\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\n]*\?>/y;
const DOCTYPE = /<!DOCTYPE[ \t\n]+[\p{L}_:]/uy;
/** Characters XML 1.0 forbids anywhere in a document. */
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿\p{Cs}]/u;
const REFERENCE = /&(?:#([0-9]+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));|&/g;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const ROOTS = new Set(["testsuites", "testsuite", "testcase"]);

function xmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/** Decode `&amp; &lt; &gt; &quot; &apos; &#NN; &#xNN;`. Anything else after an `&` is an error. */
function decode(text: string, fail: (reason: string) => never): string {
  if (!text.includes("&")) return text;
  return text.replace(REFERENCE, (match, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (named !== undefined) return NAMED[named]!;
    if (match === "&") return fail("a bare '&' or an undefined entity");
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16);
    if (!xmlChar(cp)) return fail(`character reference ${match} is not an XML character`);
    return String.fromCodePoint(cp);
  });
}

function readCases(source: string): RawCase[] {
  let s = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (FORBIDDEN.test(s)) throw new JunitError("JUnit XML doesn't parse: a character XML does not allow");
  s = s.replace(/\r\n?/g, "\n");
  const n = s.length;
  let i = 0;
  const cases: RawCase[] = [];
  const stack: Frame[] = [];

  function fail(reason: string, at: number = i): never {
    const before = s.slice(0, at).split("\n");
    const line = before.length;
    const column = before[line - 1]!.length;
    throw new JunitError(`JUnit XML doesn't parse: ${reason}: line ${line}, column ${column}`);
  }
  function skipWs(): boolean {
    const start = i;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x09) i++;
      else break;
    }
    return i > start;
  }
  function readName(): string {
    NAME.lastIndex = i;
    const m = NAME.exec(s);
    if (!m) fail("not a name");
    i += m[0].length;
    return m[0];
  }
  function checkQName(name: string): void {
    const parts = name.split(":");
    if (parts.length > 2 || parts.some((p) => p === "")) fail(`'${name}' is not a valid namespaced name`);
  }
  function lookup(prefix: string, own: Map<string, string> | null): string | undefined {
    if (own?.has(prefix)) return own.get(prefix);
    for (let k = stack.length - 1; k >= 0; k--) {
      const m = stack[k]!.ns;
      if (m?.has(prefix)) return m.get(prefix);
    }
    return prefix === "xml" ? XML_NS : undefined;
  }
  function skipComment(): void {
    const end = s.indexOf("-->", i + 4);
    if (end < 0) fail("unterminated comment");
    const body = s.slice(i + 4, end);
    if (body.includes("--") || body.endsWith("-")) fail("'--' inside a comment");
    i = end + 3;
  }
  function skipPi(): void {
    const at = i;
    i += 2;
    const target = readName();
    if (target.toLowerCase() === "xml") {
      if (at !== 0 || target !== "xml") fail("XML or text declaration not at start of entity", at);
      XML_DECL.lastIndex = at;
      const m = XML_DECL.exec(s);
      if (!m) fail("bad XML declaration", at);
      i = at + m[0].length;
      return;
    }
    if (s.startsWith("?>", i)) {
      i += 2;
      return;
    }
    if (!skipWs()) fail("bad processing instruction");
    const end = s.indexOf("?>", i);
    if (end < 0) fail("unterminated processing instruction");
    i = end + 2;
  }
  function skipDoctype(): void {
    DOCTYPE.lastIndex = i;
    if (!DOCTYPE.exec(s)) fail("bad DOCTYPE");
    let depth = 0;
    let quote = "";
    i += 9;
    while (i < n) {
      const c = s[i]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (c === ">" && depth <= 0) {
        i++;
        return;
      }
      i++;
    }
    fail("unterminated DOCTYPE");
  }
  function startTag(): void {
    i++; // the "<"
    const name = readName();
    checkQName(name);
    const plain: Array<[string, string]> = [];
    const seen = new Set<string>();
    let own: Map<string, string> | null = null;
    let selfClosing = false;
    for (;;) {
      const spaced = skipWs();
      const c = s[i];
      if (c === ">") {
        i++;
        break;
      }
      if (c === "/") {
        if (s[i + 1] !== ">") fail("a '/' that does not end the tag");
        i += 2;
        selfClosing = true;
        break;
      }
      if (c === undefined) fail("unclosed tag");
      if (!spaced) fail("no whitespace between attributes");
      const attr = readName();
      checkQName(attr);
      skipWs();
      if (s[i] !== "=") fail("attribute without a value");
      i++;
      skipWs();
      const q = s[i];
      if (q !== '"' && q !== "'") fail("attribute value not quoted");
      const end = s.indexOf(q, i + 1);
      if (end < 0) fail("unterminated attribute value");
      const raw = s.slice(i + 1, end);
      if (raw.includes("<")) fail("'<' in an attribute value");
      // Attribute-value normalisation: a literal tab or newline is a space; a reference keeps its character.
      const value = decode(raw.replace(/[\t\n]/g, " "), fail);
      i = end + 1;
      if (seen.has(attr)) fail(`duplicate attribute '${attr}'`);
      seen.add(attr);
      if (attr === "xmlns") (own ??= new Map()).set("", value);
      else if (attr.startsWith("xmlns:")) {
        if (value === "") fail(`cannot undeclare the prefix '${attr.slice(6)}'`);
        (own ??= new Map()).set(attr.slice(6), value);
      } else plain.push([attr, value]);
    }

    let tag: string | null;
    const colon = name.indexOf(":");
    if (colon >= 0) {
      if (lookup(name.slice(0, colon), own) === undefined) fail(`unbound prefix '${name.slice(0, colon)}'`);
      tag = null;
    } else {
      tag = lookup("", own) ? null : name;
    }
    const attrs = new Map<string, string>();
    for (const [k, v] of plain) {
      const at = k.indexOf(":");
      if (at >= 0) {
        if (lookup(k.slice(0, at), own) === undefined) fail(`unbound prefix '${k.slice(0, at)}'`);
      } else attrs.set(k, v);
    }

    if (stack.length === 0 && !ROOTS.has(name.slice(colon + 1))) {
      throw new JunitError(`not a JUnit report: the root element is <${name}>`);
    }
    const parent = stack[stack.length - 1];
    if (parent?.testcase && (tag === "failure" || tag === "error" || tag === "skipped")) parent.testcase[tag] = true;
    let testcase: RawCase | null = null;
    if (tag === "testcase") {
      testcase = { attrs, failure: false, error: false, skipped: false };
      cases.push(testcase);
    }
    if (!selfClosing) stack.push({ name, tag, ns: own, testcase });
  }
  function endTag(): void {
    i += 2;
    const name = readName();
    skipWs();
    if (s[i] !== ">") fail("bad end tag");
    i++;
    const top = stack.pop();
    if (!top || top.name !== name) fail(`mismatched tag </${name}>`);
  }
  function checkText(text: string): void {
    if (text.includes("]]>")) fail("']]>' in text");
    decode(text, fail);
  }

  // Before the root: the XML declaration, comments, processing instructions, a DOCTYPE.
  for (;;) {
    skipWs();
    if (i >= n) fail("no element found");
    if (s.startsWith("<!--", i)) skipComment();
    else if (s.startsWith("<?", i)) skipPi();
    else if (s.startsWith("<!DOCTYPE", i)) skipDoctype();
    else if (s[i] === "<" && s[i + 1] !== "!" && s[i + 1] !== "?" && s[i + 1] !== "/") break;
    else fail("syntax error");
  }
  // The root and everything in it.
  startTag();
  while (stack.length > 0) {
    const lt = s.indexOf("<", i);
    if (lt < 0) fail("unclosed token", n);
    checkText(s.slice(i, lt));
    i = lt;
    if (s.startsWith("</", i)) endTag();
    else if (s.startsWith("<!--", i)) skipComment();
    else if (s.startsWith("<![CDATA[", i)) {
      const end = s.indexOf("]]>", i + 9);
      if (end < 0) fail("unterminated CDATA section");
      i = end + 3;
    } else if (s.startsWith("<?", i)) skipPi();
    else if (s[i + 1] === "!") fail("unexpected markup declaration");
    else startTag();
  }
  // After the root: whitespace, comments and processing instructions only.
  for (;;) {
    skipWs();
    if (i >= n) break;
    if (s.startsWith("<!--", i)) skipComment();
    else if (s.startsWith("<?", i)) skipPi();
    else fail("junk after document element");
  }
  return cases;
}

// ---------------------------------------------------------------------------------------- the JUnit report

function statusOf(c: RawCase): TestStatus {
  return c.failure ? "failed" : c.error ? "error" : c.skipped ? "skipped" : "passed";
}

/**
 * Training's `_merge`: record one outcome. A test reported twice with different outcomes is a malformed report
 * (the reason is returned), except pytest's rerun of a setup error, which reports the call and the teardown as two
 * cases: a failure wins, else the error does. The first outcome stays when the report is malformed.
 */
function merge(results: Map<string, TestStatus>, key: string, status: TestStatus): string | null {
  const previous = results.get(key);
  if (previous === undefined || previous === status) {
    results.set(key, status);
    return null;
  }
  const settled = (x: TestStatus) => x === "passed" || x === "error" || x === "failed";
  if (settled(previous) && settled(status)) {
    results.set(key, previous === "failed" || status === "failed" ? "failed" : "error");
    return null;
  }
  return `${key} reported as both ${previous} and ${status}`;
}

/**
 * `_junit_cases` and `Pytest.parse`'s loop: every `<testcase>` in the report, keyed by `keyOf` (a case it gives
 * no key for is ignored), merged by training's rule. `bad` is the first report-level problem training would flag
 * (a test reported with outcomes that cannot merge), with `results` as training leaves them. Throws on XML that is
 * not a JUnit report.
 */
export function parseJunitDetailed(
  xml: string,
  keyOf: (c: JunitCase) => string | null,
): { results: Map<string, TestStatus>; bad: string | null } {
  const results = new Map<string, TestStatus>();
  let bad: string | null = null;
  for (const c of readCases(xml)) {
    const key = keyOf({
      file: c.attrs.get("file") ?? null,
      classname: c.attrs.get("classname") ?? "",
      name: c.attrs.get("name") ?? "",
    });
    if (key) bad = bad ?? merge(results, key, statusOf(c));
  }
  return { results, bad };
}

/**
 * Test ids and their outcomes from a JUnit report. Throws a `JunitError` when the XML does not parse as a JUnit
 * report, and, as training treats it, when a test is reported with outcomes that cannot merge (see
 * `parseJunitDetailed` for the results alongside that reason).
 */
export function parseJunit(xml: string, keyOf: (c: JunitCase) => string | null): Map<string, TestStatus> {
  const { results, bad } = parseJunitDetailed(xml, keyOf);
  if (bad !== null) throw new JunitError(bad);
  return results;
}

// ------------------------------------------------------------------------------------------------ test ids

/** `posixpath.join(a, b)` for two strings. */
function posixJoin(a: string, b: string): string {
  if (b.startsWith("/")) return b;
  if (a === "" || a.endsWith("/")) return a + b;
  return `${a}/${b}`;
}

/** `posixpath.normpath`: exactly two leading slashes stay two, any other number becomes one. */
function posixNormpath(path: string): string {
  if (path === "") return ".";
  const initial = path.startsWith("/") ? (path.startsWith("//") && !path.startsWith("///") ? 2 : 1) : 0;
  const out: string[] = [];
  for (const comp of path.split("/")) {
    if (comp === "" || comp === ".") continue;
    if (comp !== ".." || (initial === 0 && out.length === 0) || (out.length > 0 && out[out.length - 1] === "..")) out.push(comp);
    else if (out.length > 0) out.pop();
  }
  return "/".repeat(initial) + out.join("/") || ".";
}

/**
 * Training's `pytest_key`: a pytest node id (`tests/test_x.py::TestA::test_b[1]`) from a JUnit testcase. xunit1
 * carries `file`; the classname is the module path (maybe shortened by the rootdir) followed by class names. With
 * no `file`, the longest classname prefix that does not end in a capitalised part is the module. `base` is the
 * test run's folder below the repository root (`.` for the root). Null when the case has no name.
 */
export function pytestKey(file: string | null, classname: string, name: string, base: string = "."): string | null {
  if (!name) return null;
  const parts = classname ? classname.split(".") : [];
  let path: string;
  let rest: string[];
  if (file) {
    file = file.replaceAll("\\", "/");
    const module = file.endsWith(".py") ? file.slice(0, -3).replaceAll("/", ".") : file.replaceAll("/", ".");
    const modParts = module.split(".");
    rest = parts;
    for (let k = 0; k < modParts.length; k++) {
      const tail = modParts.slice(k);
      if (parts.length >= tail.length && tail.every((p, at) => parts[at] === p)) {
        rest = parts.slice(tail.length);
        break;
      }
    }
    path = base !== "" && base !== "." ? posixNormpath(posixJoin(base, file)) : file;
  } else {
    let split = parts.length;
    while (split > 0 && /^\p{Uppercase}/u.test(parts[split - 1]!)) split--;
    path = `${parts.slice(0, split).join("/")}.py`;
    rest = parts.slice(split);
  }
  return [path, ...rest, name].join("::");
}

/**
 * Our own rule for Playwright's JUnit report (D-184): the testcase's `classname` (the spec file relative to the
 * config's `testDir`) with `\` turned into `/`, then `::`, then its `name` as the report prints it (describe titles
 * joined by ` › `).
 */
export function playwrightKey(classname: string, name: string): string {
  return `${classname.replaceAll("\\", "/")}::${name}`;
}

// ---------------------------------------------------------------------------------------------- resolved

/**
 * Training's `score` rule. `f2pPassed` counts the fail-to-pass ids whose outcome is `passed`; `p2pFailed` counts
 * the pass-to-pass ids whose outcome is anything else, a missing id and a skipped one included. Resolved means
 * there is at least one f2p id, all of them passed, and no p2p id failed in that sense.
 */
export function resolvedFrom(
  results: Map<string, TestStatus>,
  f2p: string[],
  p2p: string[],
): { resolved: boolean; f2pPassed: number; p2pFailed: number } {
  let f2pPassed = 0;
  for (const id of f2p) if (results.get(id) === "passed") f2pPassed++;
  let p2pFailed = 0;
  for (const id of p2p) if (results.get(id) !== "passed") p2pFailed++;
  return { resolved: f2p.length > 0 && f2pPassed === f2p.length && p2pFailed === 0, f2pPassed, p2pFailed };
}
