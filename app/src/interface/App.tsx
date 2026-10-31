// KV cache: none; the interface never touches the bytes sent to the model.
// The interactive app: the transcript of the current run, the sub-call panel, the approval prompt,
// the prompt box and the status line, in a frame one row shorter than the terminal. App owns focus,
// the screens, the submit flow and the Esc order: deny the approval, close the screen or view,
// cancel the run, clear the prompt. Each question is a new run (S-11).

import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, parse, resolve } from "node:path";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { provider } from "../gateway/providers.ts";
import type { StartRun } from "../session.ts";
import { APP_VERSION } from "../version.ts";
import { Approval, approvalHeight } from "./Approval.tsx";
import { COMMANDS, slashMatches } from "./commands/index.ts";
import { layoutHeights } from "./format.ts";
import { Lines } from "./Lines.tsx";
import { parseQuestion } from "./mentions.ts";
import { HISTORY_MAX, PromptBox } from "./PromptBox.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { engineStoppedMessage, isActive, RunStore, statusModel, type AppDeps } from "./store.ts";
import { allRows, SubcallPanel, type PanelState } from "./SubcallPanel.tsx";
import { SubcallView } from "./SubcallView.tsx";
import { makeTheme, paint, span, ThemeContext } from "./theme.ts";
import { bannerLines, Transcript, transcriptLines } from "./Transcript.tsx";

export const MIN_COLUMNS = 50;
export const MIN_ROWS = 12;
const QUIT_WINDOW_MS = 2000;
const MENU_MAX = 8;
const DENY = { allow: false, remember_for_run: false };
const HINT = "Ask a question. @file reads files; / for commands";

/** A `.git` in `dir` or a parent. */
function inGitRepo(dir: string): boolean {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(resolve(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}

/** The home folder or a drive root: listing it would take long and show the model a lot. */
function veryLarge(dir: string): boolean {
  const d = resolve(dir);
  return d === resolve(homedir()) || parse(d).root === d;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function App(props: { deps: AppDeps }) {
  const { deps } = props;
  const { exit } = useApp();
  const env = deps.env ?? process.env;
  const theme = useMemo(() => makeTheme(env), [env]);
  const win = useWindowSize();
  const size = deps.size ?? { columns: win.columns || 80, rows: win.rows || 24 };
  const [store] = useState(() => new RunStore(deps));
  useEffect(() => () => store.dispose(), [store]);
  const view = useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => store.snapshot(),
  );
  const approvalsVersion = useSyncExternalStore(
    (fn) => deps.approvals.subscribe(fn),
    () => deps.approvals.version,
  );

  const [text, setText] = useState("");
  const history = useRef<string[]>([]);
  const [screen, setScreen] = useState<string | null>(null);
  const [subview, setSubview] = useState<string | null>(null);
  const [focus, setFocus] = useState<"prompt" | "panel">("prompt");
  const [panel, setPanel] = useState<PanelState>({ selected: 0, open: {} });
  const [scroll, setScroll] = useState(0);
  const [full, setFull] = useState(false);
  const [modeOverride, setModeOverride] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; onYes(): void } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [quitting, setQuitting] = useState(false);
  const [engineVersion, setEngineVersion] = useState<string | null>(null);
  const ctrlCAt = useRef(0);
  const busy = useRef(false);
  const cancelWhenStarted = useRef(false);

  useEffect(() => {
    deps.session.info().then(
      (info) => setEngineVersion(info.version),
      () => undefined,
    );
  }, [deps.session]);

  const nextMode = modeOverride ?? deps.session.settings.permissions.mode;
  const head = deps.approvals.head();
  const keyboardFree = !head && !confirm;

  // -- actions --

  const cancelRun = () => {
    const { phase, runId } = store.live();
    if (phase !== "starting" && phase !== "running") return;
    deps.approvals.denyAll();
    store.cancelling();
    if (runId === null) {
      cancelWhenStarted.current = true;
      return;
    }
    deps.session.cancel(runId).catch((err: unknown) => store.note(`Cancel failed: ${messageOf(err)}`, "error"));
  };

  const quit = async () => {
    setQuitting(true);
    setHint("Quitting...");
    deps.approvals.denyAll();
    const { phase, runId } = store.live();
    if (isActive(phase) && runId !== null) deps.session.cancel(runId).catch(() => undefined);
    await deps.session.close().catch(() => undefined);
    exit();
  };

  const start = (run: StartRun, display: string, warnings: string[]) => {
    const detail = run.mode === "read" ? `read: ${run.inputs!.length} file${run.inputs!.length === 1 ? "" : "s"}` : `repo: ${deps.cwd}`;
    history.current = [...history.current, display].slice(-HISTORY_MAX);
    setText("");
    setScroll(0);
    setPanel({ selected: 0, open: {} });
    setFocus("prompt");
    setSubview(null);
    store.beginRun({ text: run.mode === "read" ? run.question! : run.task!, detail });
    for (const w of warnings) store.note(w, "warn");
    cancelWhenStarted.current = false;
    deps.session.start({ ...run, permissionMode: nextMode }).then(
      (r) => {
        store.startResolved(r.run_id);
        if (cancelWhenStarted.current) deps.session.cancel(r.run_id).catch(() => undefined);
      },
      (err: unknown) => store.startFailed(messageOf(err)),
    );
  };

  const submit = async (value: string) => {
    const typed = value.trim();
    if (!typed || busy.current) return;
    if (typed.startsWith("/")) {
      const name = typed.slice(1).split(/\s/)[0]!.toLowerCase();
      if (name === "quit") return void quit();
      if (!COMMANDS.some((c) => c.name === name)) return store.note(`Unknown command /${name}. /help lists the commands.`, "warn");
      history.current = [...history.current, typed].slice(-HISTORY_MAX);
      setText("");
      setScreen(name);
      return;
    }
    const exited = store.snapshot().engineExit;
    if (exited) return store.note(engineStoppedMessage(exited.code), "error");
    if (isActive(store.live().phase)) return store.note("A run is active. Esc cancels it.", "warn");
    const parsed = parseQuestion(typed, deps.cwd);
    if (!parsed.ok) return store.note(parsed.error, "error");
    const settings = deps.session.settings;
    if (settings.root.model === "") {
      store.note("No model picked. Use /model.", "warn");
      setScreen("model");
      return;
    }
    const rootProvider = settings.root.model.slice(0, settings.root.model.indexOf("/"));
    const def = provider(rootProvider);
    if (def?.needsKey) {
      busy.current = true;
      try {
        if ((await deps.keys.resolve(rootProvider)) === null) return store.note(`No key for ${def.name}. Use /providers.`, "warn");
      } catch (err) {
        return store.note(`Could not read the saved key for ${def.name}: ${messageOf(err)}`, "error");
      } finally {
        busy.current = false;
      }
    }
    const run = parsed.run;
    const warnings: string[] = [];
    if (run.mode === "repo") {
      if (!inGitRepo(deps.cwd)) warnings.push(`No git repository in ${deps.cwd} or its parents, so diff() will be unavailable.`);
      if (veryLarge(deps.cwd)) {
        setConfirm({ text: "This folder is very large. Run on it anyway? y/N", onYes: () => start(run, typed, warnings) });
        return;
      }
    }
    start(run, typed, warnings);
  };

  const onCtrlC = () => {
    // a run that is already cancelling counts as idle here, so a hung cancel can still be quit
    const { phase } = store.live();
    if (phase === "starting" || phase === "running") return cancelRun();
    const now = Date.now();
    if (now - ctrlCAt.current <= QUIT_WINDOW_MS) return void quit();
    ctrlCAt.current = now;
    setHint("Press Ctrl+C again to quit.");
  };

  // -- layout --

  const tooSmall = size.columns < MIN_COLUMNS || size.rows < MIN_ROWS;
  const menu = screen || subview || !keyboardFree || focus !== "prompt" ? [] : slashMatches(text);
  const showPanel = !screen && !subview && view.blocks.length > 0;
  const wantApproval = head ? approvalHeight(head, size.columns) : confirm ? 3 : 0;
  const h = layoutHeights(size.rows, { panel: showPanel, approval: wantApproval, menu: Math.min(menu.length, MENU_MAX) });
  const mainHeight = h.transcript + h.panel;
  const lines = useMemo(() => {
    if (view.entries.length === 0 && view.phase === "idle") {
      const s = deps.session.settings;
      return bannerLines({ app: APP_VERSION, engine: engineVersion, folder: deps.cwd, root: s.root.model || "none (use /model)", sub: s.sub.model || "same" }, size.columns);
    }
    return transcriptLines(view.entries, size.columns, theme, { full, now: view.now });
  }, [view, size.columns, theme, full, engineVersion, deps, deps.session.settings]);
  const maxScroll = Math.max(0, lines.length - h.transcript);

  useInput((input, key) => {
    if (key.ctrl && input === "c") return onCtrlC();
    if (confirm) {
      const c = confirm;
      setConfirm(null);
      if (input.toLowerCase() === "y") c.onYes();
      else store.note("Not started.", "info");
      return;
    }
    if (key.escape) {
      if (deps.approvals.head()) return deps.approvals.answer(DENY);
      if (screen || subview) return; // they close themselves
      if (focus === "panel") return setFocus("prompt");
      const { phase } = store.live();
      if (phase === "starting" || phase === "running") return cancelRun();
      return setText("");
    }
    if (deps.approvals.head() || screen || subview) return;
    if (key.ctrl && input === "o") setFull((f) => !f);
    else if (key.pageUp) setScroll((s) => Math.min(maxScroll, s + Math.max(1, h.transcript - 1)));
    else if (key.pageDown) setScroll((s) => Math.max(0, Math.min(maxScroll, s) - Math.max(1, h.transcript - 1)));
    else if (key.end) setScroll(0);
  });

  if (tooSmall) {
    return (
      <Box width={size.columns} height={Math.max(1, size.rows - 1)}>
        <Text wrap="truncate-end">{`Terminal too small (need ${MIN_COLUMNS}x${MIN_ROWS})`}</Text>
      </Box>
    );
  }

  const rows = allRows(view.blocks);
  const row = subview === null ? undefined : rows.find((r) => r.key === subview);
  const command = screen === null ? undefined : COMMANDS.find((c) => c.name === screen);
  const engineGone = view.engineExit !== null;
  const placeholder = engineGone ? engineStoppedMessage(view.engineExit!.code) : (hint ?? (isActive(view.phase) ? "A run is active; Esc cancels it." : HINT));

  let main;
  if (command) {
    main = (
      <command.Screen
        deps={deps}
        store={store}
        view={view}
        close={() => setScreen(null)}
        permissionMode={nextMode}
        setPermissionMode={setModeOverride}
        active={keyboardFree}
        width={size.columns}
        height={mainHeight}
      />
    );
  } else if (row) {
    main = (
      <SubcallView
        key={row.key}
        row={row}
        block={view.blocks.find((b) => b.id === row.batchId)}
        cellCode={view.cellCode}
        now={view.now}
        width={size.columns}
        height={mainHeight}
        active={keyboardFree}
        onClose={() => setSubview(null)}
        onStep={(dir) => {
          const at = rows.findIndex((r) => r.key === row.key);
          const next = rows[Math.max(0, Math.min(rows.length - 1, at + dir))];
          if (next) setSubview(next.key);
        }}
      />
    );
  } else {
    main = (
      <>
        <Transcript lines={lines} scroll={Math.min(scroll, maxScroll)} width={size.columns} height={h.transcript} />
        {h.panel > 0 ? (
          <SubcallPanel
            blocks={view.blocks}
            state={panel}
            onState={setPanel}
            focused={keyboardFree && focus === "panel"}
            now={view.now}
            width={size.columns}
            height={h.panel}
            onOpen={setSubview}
            onLeave={() => setFocus("prompt")}
          />
        ) : null}
      </>
    );
  }

  return (
    <ThemeContext.Provider value={theme}>
      <Box flexDirection="column" width={size.columns} height={size.rows - 1} overflow="hidden">
        {main}
        {head && h.approval > 0 ? (
          <Approval
            key={approvalsVersion}
            params={head}
            waiting={deps.approvals.size - 1}
            width={size.columns}
            height={h.approval}
            active
            onAnswer={(r) => deps.approvals.answer(r)}
          />
        ) : null}
        {!head && confirm && h.approval > 0 ? (
          <Box borderStyle={theme.border} borderColor={paint(theme, "yellow")} paddingX={1} height={h.approval} width={size.columns}>
            <Lines lines={[[span(confirm.text, { bold: true })]]} height={Math.max(0, h.approval - 2)} width={size.columns - 4} />
          </Box>
        ) : null}
        <PromptBox
          value={text}
          onChange={(v) => {
            setText(v);
            setHint(null);
          }}
          onSubmit={(v) => void submit(v)}
          disabled={quitting}
          hint={placeholder}
          active={keyboardFree && !screen && !subview && focus === "prompt"}
          width={size.columns}
          menu={menu}
          menuHeight={h.menu}
          cwd={deps.cwd}
          history={history.current}
          onFocusPanel={() => {
            if (view.blocks.length > 0) setFocus("panel");
          }}
        />
        <StatusLine segments={statusModel(view, deps, nextMode)} width={size.columns} />
      </Box>
    </ThemeContext.Provider>
  );
}

/** Bare `rlmh`: render the app and wait until it exits. Ctrl+C is the app's own (cancel a run, or twice to quit). */
export async function runApp(deps: AppDeps): Promise<void> {
  const instance = render(<App deps={deps} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
}
