// KV cache: none
// `rlmh update` (cli/update.ts): finding the latest release from a redirect, the checksum gate, the
// installer's command and environment, and the Windows rename-aside and put-back. Offline: github.com is
// a fake fetch, the installer is a callback, and the platform is a parameter, so every branch runs on
// every OS. One test runs the real fetch against a local server to check the manual redirect.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, normalizeVersion, REPO_URL, runUpdate, sweepOldBinaries, type UpdateOptions } from "../src/cli/update.ts";
import { binDir } from "../src/paths.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rlmh-update-test-")));
  temps.push(dir);
  return dir;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const INSTALL_SH = "#!/bin/sh\necho 'fake install.sh'\n";
const INSTALL_PS1 = "Write-Host 'fake install.ps1'\n";

/** A SHA256SUMS the way release.yml writes it: every asset, two spaces between digest and name. */
function sums(over: Record<string, string> = {}): string {
  const files: Record<string, string> = {
    "rlmh-linux-x64": sha("linux binary"),
    "rlmh-windows-x64.exe": sha("windows binary"),
    "install.sh": sha(INSTALL_SH),
    "install.ps1": sha(INSTALL_PS1),
    ...over,
  };
  return `${Object.entries(files).map(([name, digest]) => `${digest}  ${name}`).join("\n")}\n`;
}

interface Github {
  fetch: NonNullable<UpdateOptions["fetch"]>;
  requests: { url: string; init?: RequestInit }[];
}

/** A fake github.com: /releases/latest redirects to the latest tag, /releases/download/v<version>/<file> serves `files`. */
function github(o: { latest?: string; files?: Record<string, string | null> } = {}): Github {
  const requests: Github["requests"] = [];
  const files: Record<string, string | null> = { "SHA256SUMS": sums(), "install.sh": INSTALL_SH, "install.ps1": INSTALL_PS1, ...(o.files ?? {}) };
  const fetch: Github["fetch"] = async (url, init) => {
    requests.push({ url, init });
    if (url === `${REPO_URL}/releases/latest`) {
      if (o.latest === undefined) return new Response("not found", { status: 404 });
      // a request that follows redirects would be handed the tag page; manual gets the redirect itself
      if (init?.redirect !== "manual") return new Response("the tag page", { status: 200 });
      return new Response(null, { status: 302, headers: { location: `${REPO_URL}/releases/tag/v${o.latest}` } });
    }
    const m = new RegExp(`^${REPO_URL}/releases/download/v([^/]+)/(.+)$`).exec(url);
    const body = m ? files[m[2]!] : undefined;
    if (body === undefined || body === null) return new Response("not found", { status: 404 });
    return new Response(body);
  };
  return { fetch, requests };
}

interface Rig {
  opts: UpdateOptions;
  home: string;
  binary: string;
  out: string[];
  err: string[];
  runs: { argv: string[]; env: Record<string, string> }[];
  asked: string[];
  gh: Github;
}

/** An installed rlmh in a temp home, a fake github and a fake installer that only records how it was run. */
function rig(over: Partial<UpdateOptions> = {}, ghOver: Parameters<typeof github>[0] = { latest: "0.1.1" }, answer = true): Rig {
  const platform = over.platform ?? "linux";
  const home = temp();
  mkdirSync(binDir(home), { recursive: true });
  const binary = join(binDir(home), platform === "win32" ? "rlmh.exe" : "rlmh");
  writeFileSync(binary, "old binary");
  const gh = github(ghOver);
  const r: Rig = { opts: undefined as unknown as UpdateOptions, home, binary, out: [], err: [], runs: [], asked: [], gh };
  r.opts = {
    home,
    yes: true,
    check: false,
    interactive: false,
    out: (l) => r.out.push(l),
    err: (l) => r.err.push(l),
    ask: async (q) => (r.asked.push(q), answer),
    fetch: gh.fetch,
    run: async (argv, env) => (r.runs.push({ argv, env }), 0),
    platform,
    env: { PATH: "/bin", OPENAI_API_KEY: "sk-FAKE-1", HF_TOKEN: "hf_FAKE", OPENAI_CUSTOM_HEADERS: "Authorization: FAKE", RLMH_DOWNLOAD_BASE: "http://elsewhere.test", PLAIN: "kept" },
    execPath: binary,
    compiled: true,
    appVersion: "0.1.0",
    tmpRoot: temp(),
    ...over,
  };
  return r;
}

const said = (lines: string[]) => lines.join("\n");
const downloads = (r: Rig) => r.gh.requests.filter((q) => q.url.includes("/releases/download/")).map((q) => q.url);

describe("version helpers", () => {
  test("normalizeVersion and compareVersions", () => {
    expect(normalizeVersion("0.1.1")).toBe("0.1.1");
    expect(normalizeVersion("v0.1.1")).toBe("0.1.1");
    expect(normalizeVersion("v1.2.3-rc.1")).toBe("1.2.3-rc.1");
    for (const bad of ["", "latest", "0.1", "1.2.3.4", "v", "../../x", "0.1.1/../2", "0.1.1 ", "0.1.1?x=1", "0.1.1#a"]) expect(normalizeVersion(bad)).toBeNull();
    expect(compareVersions("0.1.1", "0.1.0")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.1.1")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0); // numbers, not strings
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0); // a release is newer than its pre-release
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.2")).toBeLessThan(0);
  });
});

describe("where it can run", () => {
  test("from a source checkout it refuses, touches no network, and exits 2", async () => {
    const r = rig({ compiled: false });
    expect(await runUpdate(r.opts)).toBe(2);
    expect(said(r.err)).toBe("This rlmh runs from a source checkout; update it with git pull.");
    expect(r.gh.requests).toEqual([]);
    expect(r.runs).toEqual([]);
  });

  test("a compiled rlmh that is not the one in <home>/bin is not replaced, but may check", async () => {
    const r = rig();
    const elsewhere = join(temp(), "rlmh");
    writeFileSync(elsewhere, "copy");
    expect(await runUpdate({ ...r.opts, execPath: elsewhere })).toBe(2);
    expect(said(r.err)).toContain("is not the one the installer put in");
    expect(r.gh.requests).toEqual([]);
    expect(await runUpdate({ ...r.opts, execPath: elsewhere, check: true })).toBe(0);
    expect(said(r.out)).toContain("0.1.1");
  });
});

describe("which release", () => {
  test("the latest tag is read from the redirect, without following it, and with no credentials", async () => {
    const r = rig({}, { latest: "0.1.0" });
    expect(await runUpdate(r.opts)).toBe(0);
    expect(said(r.out)).toBe("rlmh 0.1.0 is the latest version.");
    expect(r.gh.requests).toHaveLength(1);
    expect(r.gh.requests[0]!.url).toBe(`${REPO_URL}/releases/latest`);
    expect(r.gh.requests[0]!.init?.redirect).toBe("manual");
    expect(JSON.stringify(r.gh.requests[0]!.init?.headers ?? {})).not.toMatch(/authorization|token|key/i);
    expect(r.runs).toEqual([]);
  });

  test("a current rlmh newer than the latest release has nothing to do", async () => {
    const r = rig({ appVersion: "0.2.0" }, { latest: "0.1.1" });
    expect(await runUpdate(r.opts)).toBe(0);
    expect(said(r.out)).toContain("newer than the latest release (0.1.1)");
    expect(downloads(r)).toEqual([]);
  });

  test("--check reports current against latest and changes nothing", async () => {
    const newer = rig({ check: true, yes: false, interactive: true });
    expect(await runUpdate(newer.opts)).toBe(0);
    expect(said(newer.out)).toBe('rlmh 0.1.0 is installed; the latest version is 0.1.1. Run "rlmh update" to update.');
    expect(newer.asked).toEqual([]);
    expect(downloads(newer)).toEqual([]);
    expect(newer.runs).toEqual([]);
    expect(readFileSync(newer.binary, "utf8")).toBe("old binary");

    const same = rig({ check: true }, { latest: "0.1.0" });
    expect(await runUpdate(same.opts)).toBe(0);
    expect(said(same.out)).toBe("rlmh 0.1.0 is installed, and is the latest version.");
  });

  test("a failed lookup is a message and exit 1: no network, a 404, a redirect that names no release", async () => {
    const down = rig({ fetch: async () => Promise.reject(new Error("getaddrinfo ENOTFOUND github.com")) });
    expect(await runUpdate(down.opts)).toBe(1);
    expect(said(down.err)).toContain("could not reach");
    expect(said(down.err)).toContain("ENOTFOUND");

    const none = rig({}, {}); // /releases/latest answers 404
    expect(await runUpdate(none.opts)).toBe(1);
    expect(said(none.err)).toContain("HTTP 404");

    const odd = rig({ fetch: async () => new Response(null, { status: 302, headers: { location: `${REPO_URL}/releases` } }) });
    expect(await runUpdate(odd.opts)).toBe(1);
    expect(said(odd.err)).toContain("does not name a release");
    expect(odd.runs).toEqual([]);
  });

  test("--version names the release: no lookup, v is optional, a bad one is a usage error, the current one is already there", async () => {
    const r = rig({ version: "v0.2.0" }, { latest: "9.9.9" });
    expect(await runUpdate(r.opts)).toBe(0);
    expect(r.gh.requests.some((q) => q.url.endsWith("/releases/latest"))).toBe(false);
    expect(downloads(r)).toEqual([`${REPO_URL}/releases/download/v0.2.0/SHA256SUMS`, `${REPO_URL}/releases/download/v0.2.0/install.sh`]);
    expect(r.runs[0]!.env.RLMH_VERSION).toBe("0.2.0");

    const bad = rig({ version: "../evil" });
    expect(await runUpdate(bad.opts)).toBe(2);
    expect(said(bad.err)).toContain("--version");
    expect(bad.gh.requests).toEqual([]);

    const same = rig({ version: "0.1.0" });
    expect(await runUpdate(same.opts)).toBe(0);
    expect(said(same.out)).toBe("rlmh 0.1.0 is already installed.");
    expect(downloads(same)).toEqual([]);
  });
});

describe("asking first", () => {
  test("without --yes and without a terminal it refuses, exit 2, having downloaded nothing", async () => {
    const r = rig({ yes: false, interactive: false });
    expect(await runUpdate(r.opts)).toBe(2);
    expect(said(r.err)).toContain("--yes");
    expect(r.asked).toEqual([]);
    expect(downloads(r)).toEqual([]);
    expect(r.runs).toEqual([]);
    expect(said(r.out)).toContain("0.1.0 -> 0.1.1"); // it said what it would do
  });

  test("on a terminal it says what it will do and asks y/N", async () => {
    const yes = rig({ yes: false, interactive: true }, { latest: "0.1.1" }, true);
    expect(await runUpdate(yes.opts)).toBe(0);
    expect(yes.asked).toEqual(["Update now? [y/N] "]);
    const text = said(yes.out);
    expect(text).toContain("rlmh update: 0.1.0 -> 0.1.1");
    expect(text).toContain(`${REPO_URL}/releases/download/v0.1.1/`);
    expect(text).toContain(yes.binary);
    expect(yes.runs).toHaveLength(1);

    const no = rig({ yes: false, interactive: true }, { latest: "0.1.1" }, false);
    expect(await runUpdate(no.opts)).toBe(1);
    expect(said(no.out)).toContain("Not updated.");
    expect(downloads(no)).toEqual([]);
    expect(no.runs).toEqual([]);
  });
});

describe("the checksum gate", () => {
  test("a mismatch runs nothing and changes nothing, on any platform", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const r = rig({ platform }, { latest: "0.1.1", files: { "SHA256SUMS": sums({ "install.sh": sha("tampered"), "install.ps1": sha("tampered") }) } });
      expect(await runUpdate(r.opts)).toBe(1);
      expect(said(r.err)).toContain(`checksum mismatch for ${platform === "win32" ? "install.ps1" : "install.sh"}`);
      expect(said(r.err)).toContain("nothing was run or changed");
      expect(r.runs).toEqual([]);
      expect(readdirSync(binDir(r.home))).toEqual([platform === "win32" ? "rlmh.exe" : "rlmh"]); // not even renamed
      expect(readFileSync(r.binary, "utf8")).toBe("old binary");
    }
  });

  test("no SHA256SUMS line for the installer, or none of it, is refused too", async () => {
    const noLine = rig({}, { latest: "0.1.1", files: { "SHA256SUMS": `${sha("x")}  rlmh-linux-x64\n` } });
    expect(await runUpdate(noLine.opts)).toBe(1);
    expect(said(noLine.err)).toContain("no line for install.sh");
    expect(noLine.runs).toEqual([]);

    const lookalike = rig({}, { latest: "0.1.1", files: { "SHA256SUMS": `${sha(INSTALL_SH)}  not-install.sh\n${sha(INSTALL_SH)}  install.sh.sig\n` } });
    expect(await runUpdate(lookalike.opts)).toBe(1);
    expect(said(lookalike.err)).toContain("no line for install.sh");

    const missing = rig({}, { latest: "0.1.1", files: { "SHA256SUMS": null } });
    expect(await runUpdate(missing.opts)).toBe(1);
    expect(said(missing.err)).toContain("HTTP 404");
    expect(missing.runs).toEqual([]);
  });

  test("the installer it ran is the one that was checked; the digest may be upper case or marked binary", async () => {
    const r = rig({}, { latest: "0.1.1", files: { "SHA256SUMS": `${sha(INSTALL_SH).toUpperCase()} *install.sh\r\n` } });
    let ran = "";
    r.opts.run = async (argv) => {
      ran = readFileSync(argv[1]!, "utf8");
      return 0;
    };
    expect(await runUpdate(r.opts)).toBe(0);
    expect(ran).toBe(INSTALL_SH);
  });

  test("an installer or checksum file larger than expected is refused unread", async () => {
    const r = rig({}, { latest: "0.1.1", files: { "install.sh": "x".repeat(2 * 1024 * 1024) } });
    expect(await runUpdate(r.opts)).toBe(1);
    expect(said(r.err)).toContain("larger than");
    expect(r.runs).toEqual([]);
  });
});

describe("running the installer", () => {
  test("macOS and Linux: sh install.sh, with this home and release, no PATH change, and none of the keys", async () => {
    const r = rig();
    let scriptSeen: { exists: boolean; text: string; dir: string } | undefined;
    r.opts.run = async (argv, env) => {
      r.runs.push({ argv, env });
      scriptSeen = { exists: existsSync(argv[1]!), text: readFileSync(argv[1]!, "utf8"), dir: join(argv[1]!, "..") };
      return 0;
    };
    expect(await runUpdate(r.opts)).toBe(0);
    expect(r.runs).toHaveLength(1);
    const { argv, env } = r.runs[0]!;
    expect(argv[0]).toBe("sh");
    expect(argv).toHaveLength(2);
    expect(argv[1]!.endsWith("install.sh")).toBe(true);
    expect(scriptSeen).toMatchObject({ exists: true, text: INSTALL_SH });
    expect(env.RLMH_HOME).toBe(r.home);
    expect(env.RLMH_VERSION).toBe("0.1.1");
    expect(env.RLMH_NO_MODIFY_PATH).toBe("1");
    expect(env.PLAIN).toBe("kept");
    expect(env.PATH).toBe("/bin");
    for (const name of ["OPENAI_API_KEY", "HF_TOKEN", "OPENAI_CUSTOM_HEADERS", "RLMH_DOWNLOAD_BASE"]) expect(env[name]).toBeUndefined();
    // it only downloaded from the release's folder, in this order
    expect(r.gh.requests.map((q) => q.url)).toEqual([
      `${REPO_URL}/releases/latest`,
      `${REPO_URL}/releases/download/v0.1.1/SHA256SUMS`,
      `${REPO_URL}/releases/download/v0.1.1/install.sh`,
    ]);
    for (const q of r.gh.requests) expect(JSON.stringify(q.init?.headers ?? {})).not.toMatch(/authorization|token|key/i);
    // the binary was left for the installer to replace, and the download folder is gone
    expect(readFileSync(r.binary, "utf8")).toBe("old binary");
    expect(readdirSync(binDir(r.home))).toEqual(["rlmh"]);
    expect(existsSync(scriptSeen!.dir)).toBe(false);
    expect(said(r.out)).toContain("rlmh updated to 0.1.1.");
    expect(said(r.out)).toContain('The next "rlmh" start sets up the new engine');
    expect(said(r.out)).toContain("removes the old engine folders");
  });

  test("Windows: the running rlmh.exe is renamed aside first, and powershell runs install.ps1", async () => {
    const r = rig({ platform: "win32" });
    const during: { binary: boolean; old: string | null; argv: string[] }[] = [];
    r.opts.run = async (argv, env) => {
      r.runs.push({ argv, env });
      const old = `${r.binary}.old`;
      during.push({ binary: existsSync(r.binary), old: existsSync(old) ? readFileSync(old, "utf8") : null, argv });
      writeFileSync(r.binary, "new binary"); // what install.ps1 does: moves the new file into place
      return 0;
    };
    expect(await runUpdate(r.opts)).toBe(0);
    expect(during).toHaveLength(1);
    expect(during[0]!.binary).toBe(false); // the installer finds no rlmh.exe in its way
    expect(during[0]!.old).toBe("old binary"); // and the running one is safe beside it
    expect(during[0]!.argv.slice(0, 5)).toEqual(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
    expect(during[0]!.argv[5]!.endsWith("install.ps1")).toBe(true);
    expect(r.runs[0]!.env.RLMH_NO_MODIFY_PATH).toBe("1");
    expect(readFileSync(r.binary, "utf8")).toBe("new binary");
    expect(readFileSync(`${r.binary}.old`, "utf8")).toBe("old binary"); // the running copy stays until the next start deletes it
  });

  test("Windows: when the installer fails the old rlmh.exe comes back, whether or not a new one was placed", async () => {
    for (const placed of [false, true]) {
      const r = rig({ platform: "win32" });
      r.opts.run = async (argv, env) => {
        r.runs.push({ argv, env });
        if (placed) writeFileSync(r.binary, "half-installed binary");
        return 1;
      };
      expect(await runUpdate(r.opts)).toBe(1);
      expect(said(r.err)).toContain("The installer exited with code 1");
      expect(said(r.err)).toContain("The previous rlmh was put back.");
      expect(readFileSync(r.binary, "utf8")).toBe("old binary");
      expect(readdirSync(binDir(r.home))).toEqual(["rlmh.exe"]);
      expect(said(r.out)).not.toContain("rlmh updated");
    }
  });

  test("Windows: an installer that cannot even start also puts the old rlmh.exe back", async () => {
    const r = rig({ platform: "win32" });
    r.opts.run = async () => {
      throw new Error("spawn powershell ENOENT");
    };
    expect(await runUpdate(r.opts)).toBe(1);
    expect(said(r.err)).toContain("could not run install.ps1");
    expect(said(r.err)).toContain("The previous rlmh was put back.");
    expect(readFileSync(r.binary, "utf8")).toBe("old binary");
  });

  test("Windows: a leftover rlmh.exe.old is cleared first, and one that cannot be is stepped around", async () => {
    const r = rig({ platform: "win32" });
    writeFileSync(`${r.binary}.old`, "left by the last update");
    r.opts.run = async () => {
      expect(readFileSync(`${r.binary}.old`, "utf8")).toBe("old binary");
      return 0;
    };
    expect(await runUpdate(r.opts)).toBe(0);

    // a directory cannot be deleted as a file: it stands in for a .old that an older rlmh still holds
    const stuck = rig({ platform: "win32" });
    mkdirSync(`${stuck.binary}.old`);
    let aside = "";
    stuck.opts.run = async () => {
      aside = readdirSync(binDir(stuck.home)).find((n) => n.startsWith("rlmh.exe.old.")) ?? "";
      writeFileSync(stuck.binary, "broken");
      return 1;
    };
    expect(await runUpdate(stuck.opts)).toBe(1);
    expect(aside).toBe(`rlmh.exe.old.${process.pid}`);
    expect(readFileSync(stuck.binary, "utf8")).toBe("old binary");
    expect(existsSync(`${stuck.binary}.old`)).toBe(true); // the stuck one is left alone
  });

  test("a failed installer on macOS or Linux is reported; nothing was moved so nothing is restored", async () => {
    const r = rig();
    r.opts.run = async () => 3;
    expect(await runUpdate(r.opts)).toBe(1);
    expect(said(r.err)).toContain("The installer exited with code 3");
    expect(said(r.err)).toContain("rlmh was not updated");
    expect(readFileSync(r.binary, "utf8")).toBe("old binary");
  });
});

describe("sweepOldBinaries", () => {
  test("deletes rlmh.exe.old and rlmh.exe.old.<pid> beside the binary, and nothing else", () => {
    const dir = temp();
    for (const name of ["rlmh.exe", "rlmh.exe.old", "rlmh.exe.old.4242", "rlmh.exe.other", "uv.exe", "uv.exe.old", "rlmh.exe.older"]) writeFileSync(join(dir, name), name);
    sweepOldBinaries(join(dir, "rlmh.exe"));
    expect(readdirSync(dir).sort()).toEqual(["rlmh.exe", "rlmh.exe.older", "rlmh.exe.other", "uv.exe", "uv.exe.old"]);
    sweepOldBinaries(join(dir, "rlmh.exe")); // nothing to do: no error
    sweepOldBinaries(join(dir, "no-such-folder", "rlmh.exe"));
  });

  test.skipIf(process.platform !== "win32")("a copy still running is left, and goes the next time", async () => {
    const dir = temp();
    const running = join(dir, "rlmh.exe.old");
    await Bun.write(running, Bun.file(process.execPath)); // a real, runnable exe
    const proc = Bun.spawn({ cmd: [running, "-e", "setInterval(() => {}, 1000)"], stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep(500);
      sweepOldBinaries(join(dir, "rlmh.exe")); // cannot delete it, and does not throw
      expect(existsSync(running)).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
    sweepOldBinaries(join(dir, "rlmh.exe"));
    expect(existsSync(running)).toBe(false);
  });
});

describe("the real fetch against a local server", () => {
  test("redirect: manual reads the Location header; the downloads follow redirects; no credentials are sent", async () => {
    const seen: { path: string; headers: Record<string, string> }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
        seen.push({ path: url.pathname, headers });
        const repo = "/RishiJain905/rlm-harness";
        if (url.pathname === `${repo}/releases/latest`) return new Response(null, { status: 302, headers: { location: `${repo}/releases/tag/v0.1.1` } });
        if (url.pathname === `${repo}/releases/tag/v0.1.1`) return new Response("the release page");
        if (url.pathname === `${repo}/releases/download/v0.1.1/SHA256SUMS`) return new Response(null, { status: 302, headers: { location: "/cdn/sums" } });
        if (url.pathname === "/cdn/sums") return new Response(sums());
        if (url.pathname === `${repo}/releases/download/v0.1.1/install.sh`) return new Response(INSTALL_SH);
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const r = rig({ fetch: undefined, repoUrl: `http://127.0.0.1:${server.port}/RishiJain905/rlm-harness` });
      delete r.opts.fetch;
      expect(await runUpdate({ ...r.opts, check: true })).toBe(0);
      expect(said(r.out)).toContain("the latest version is 0.1.1");
      expect(seen.map((s) => s.path)).toEqual(["/RishiJain905/rlm-harness/releases/latest"]); // the tag page was not fetched
      expect(await runUpdate(r.opts)).toBe(0);
      expect(r.runs).toHaveLength(1);
      expect(seen.map((s) => s.path)).toContain("/cdn/sums");
      for (const s of seen) expect(Object.keys(s.headers).filter((h) => /authorization|cookie|token|key/.test(h))).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});
