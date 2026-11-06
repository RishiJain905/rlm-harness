// KV cache: none; the interface never touches the bytes sent to the model.
// The interactive app: the transcript of the current run, the sub-call panel, the approval prompt,
// the prompt box and the status line, in a frame one row shorter than the terminal. App owns focus,
// the screens, the submit flow (with /clear and /quit, which have no screen) and the Esc order: deny
// the approval, close the screen or view, cancel the run, clear the prompt. A question that fits the open conversation
// is a follow-up in it (run.say, v1 step 4); any other starts a new run, after the open conversation is closed.
// With /tune on (v1 step 9), TuneControl snapshots a new repo question's folder before its run.start, offers each first
// answer to the background queue, and makes a kept harness active once no conversation is open; /tune off has no screen.

import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, parse, resolve } from "node:path";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { provider, PROVIDERS } from "../gateway/providers.ts";
import { RpcError } from "../link.ts";
import { ErrorCode } from "../protocol.ts";
import { settingsRefs, type StartRun } from "../session.ts";
import { APP_VERSION } from "../version.ts";
import { Approval, approvalHeight } from "./Approval.tsx";
import { COMMANDS, slashMatches } from "./commands/index.ts";
import { envKeyVar } from "./commands/providers.tsx";
import { continues, refKey } from "./conversation.ts";
import { layoutHeights } from "./format.ts";
import { Lines } from "./Lines.tsx";
import { listFiles, mentionPaths, mentionToken, parseQuestion, rankFiles, RUN_CHOICES, type RunChoice } from "./mentions.ts";
import { HISTORY_MAX, PromptBox } from "./PromptBox.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { TuneControl } from "./tuning.ts";
import { engineStoppedMessage, isActive, RunStore, statusModel, type AppDeps } from "./store.ts";
import { allRows, blockOfRow, rowCellCode, SubcallPanel, type PanelState } from "./SubcallPanel.tsx";
import { SubcallView } from "./SubcallView.tsx";
import { makeTheme, paint, span, ThemeContext } from "./theme.ts";
import { bannerLines, Transcript, transcriptLines } from "./Transcript.tsx";

export const MIN_COLUMNS = 50;
export const MIN_ROWS = 12;
const QUIT_WINDOW_MS = 2000;
const MENU_MAX = 11; // every command fits: the nine with screens (/tune and /tuned since v1 step 9), /clear and /quit
const DENY = { allow: false, remember_for_run: false };
const HINT: Record<RunChoice, string> = {
  auto: "Ask a question. @file reads files; / for commands",
  repo: "Repo mode (Shift+Tab changes): works on this folder; @file names files",
  read: "Read mode (Shift+Tab changes): ask about @files",
};
const WELCOME_PROVIDERS = "Welcome to rlmh. Connect a provider: pick one, a adds a key; Esc when done.";
const WELCOME_MODEL = "Pick the root model: Enter on root, then a provider and a model; Esc when done.";
const NO_MODEL_YET = "No model picked yet: /model picks one, /providers adds a key.";
/** run.say answered -32010: the engine had already closed the conversation (v1 step 4). */
export const CONVERSATION_ENDED = "That conversation had ended, so this starts a new one.";

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

/** A saved key, or a provider key in the environment. */
async function anyKey(deps: AppDeps, env: Record<string, string | undefined>): Promise<boolean> {
  if ((await deps.keys.list()).length > 0) return true;
  return PROVIDERS.some((p) => p.needsKey && envKeyVar(p, env) !== null);
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
  const [tune] = useState(() => new TuneControl(deps, store));
  useEffect(() => {
    tune.startup();
    return () => tune.dispose();
  }, [tune]);
  useSyncExternalStore(
    (fn) => tune.subscribe(fn),
    () => tune.version,
  );
  const view = useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => store.snapshot(),
  );
  const approvalsVersion = useSyncExternalStore(
    (fn) => deps.approvals.subscribe(fn),
    () => deps.approvals.version,
  );

  const [text, setText] = useState("");
  const [runChoice, setRunChoice] = useState<RunChoice>("auto"); // Shift+Tab (D-156); kept until /clear or quit
  // the prompt text Esc closed the file menu on; any change to the text opens it again
  const [filesClosedAt, setFilesClosedAt] = useState<string | null>(null);
  useEffect(() => {
    if (filesClosedAt !== null && text !== filesClosedAt) setFilesClosedAt(null);
  }, [text, filesClosedAt]);
  const history = useRef<string[]>([]);
  const [screen, setScreen] = useState<string | null>(null);
  const [screenArg, setScreenArg] = useState(""); // the word after the command's name: /tune on
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
  // First run, when no model is picked: /providers (only if no key exists anywhere), then /model.
  const onboarding = useRef<"providers" | "model" | null>(null);

  useEffect(() => {
    if (deps.session.settings.root.model !== "") return;
    let live = true;
    anyKey(deps, env).then(
      (has) => {
        if (!live) return;
        onboarding.current = has ? "model" : "providers";
        setScreen((s) => s ?? onboarding.current);
        setHint(has ? WELCOME_MODEL : WELCOME_PROVIDERS);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [deps, env]);

  /** Closes the open screen; during onboarding, /providers hands on to /model. */
  const closeScreen = () => {
    const was = screen;
    setScreen(null);
    if (onboarding.current === "providers" && was === "providers" && deps.session.settings.root.model === "") {
      onboarding.current = "model";
      setScreen("model");
      setHint(WELCOME_MODEL);
      return;
    }
    if (onboarding.current !== null) {
      onboarding.current = null;
      setHint(deps.session.settings.root.model === "" ? NO_MODEL_YET : null);
    }
  };

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

  /** The open conversation, if any: run.close, and back once run.closed was sent. A failure is a note, never a throw. */
  const closeConversation = async () => {
    const conv = store.conversation();
    if (!conv?.open) return;
    try {
      await deps.session.closeRun(conv.runId);
    } catch (err) {
      store.note(`Closing the conversation failed: ${messageOf(err)}`, "error");
    }
    store.conversationEnded();
  };

  const quit = async () => {
    setQuitting(true);
    setHint("Quitting...");
    deps.approvals.denyAll();
    const { phase, runId } = store.live();
    if (isActive(phase) && runId !== null) deps.session.cancel(runId).catch(() => undefined);
    else await closeConversation();
    await tune.quit().catch(() => undefined); // the pending switch applies; the tune in flight is cancelled
    await deps.session.close().catch(() => undefined);
    exit();
  };

  /** A fresh run: the open conversation is closed first, then v0's start with `conversation.follow_ups` (v1 step 4). */
  const start = async (run: StartRun, display: string, warnings: string[], notes: string[] = []) => {
    history.current = [...history.current, display].slice(-HISTORY_MAX);
    setText("");
    if (store.conversation()?.open) {
      busy.current = true;
      try {
        await tune.holdingSwitch(closeConversation);
      } finally {
        busy.current = false;
      }
    }
    const switched = tune.conversationEnded(); // a kept harness that waited for that conversation to end
    const detail = run.mode === "read" ? `read: ${run.inputs!.length} file${run.inputs!.length === 1 ? "" : "s"}` : `repo: ${deps.cwd}`;
    setScroll(0);
    setPanel({ selected: 0, open: {} });
    setFocus("prompt");
    setSubview(null);
    store.beginRun({ text: run.mode === "read" ? run.question! : run.task!, detail });
    for (const n of notes) store.note(n, "info");
    for (const w of warnings) store.note(w, "warn");
    if (switched !== null) store.note(switched, "info");
    cancelWhenStarted.current = false;
    // with /tune on, a repo question's folder is snapshotted first (the phase is starting, so nothing else submits)
    let tracked: ReturnType<TuneControl["track"]> | null = null;
    if (tune.enabled) {
      const s = await tune.snapshotFor(run);
      if (s.note !== null) store.note(s.note, "info");
      if (s.tuned) tracked = tune.track(run, s.snap);
    }
    deps.session.start({ ...run, permissionMode: nextMode, conversation: deps.session.settings.conversation.follow_ups }).then(
      (r) => {
        tracked?.resolved(r.run_id);
        store.startResolved(r.run_id);
        if (cancelWhenStarted.current) deps.session.cancel(r.run_id).catch(() => undefined);
      },
      (err: unknown) => {
        tracked?.failed();
        store.startFailed(messageOf(err));
      },
    );
  };

  /** A follow-up in the open conversation: run.say with `text`. A -32010 means the engine had closed it, so `fresh` runs. */
  const followUp = async (runId: string, text: string, display: string, fresh: () => void) => {
    history.current = [...history.current, display].slice(-HISTORY_MAX);
    setText("");
    setScroll(0);
    setFocus("prompt");
    setSubview(null);
    store.beginFollowUp(text);
    busy.current = true;
    try {
      const r = await deps.session.say(runId, text);
      store.followUpResolved(r.prompt_index);
    } catch (err) {
      if (err instanceof RpcError && err.code === ErrorCode.UNKNOWN_RUN) {
        store.followUpFailed();
        store.conversationEnded();
        history.current = history.current.slice(0, -1); // the fresh start keeps it again
        busy.current = false;
        return fresh();
      }
      store.followUpFailed(messageOf(err));
    } finally {
      busy.current = false;
    }
  };

  /** /clear: a new session without a new engine. An open conversation is closed first; a run is not cancelled for it. */
  const clear = async () => {
    if (isActive(store.live().phase) || deps.approvals.head() || confirm) {
      return store.note("A run is active. Esc cancels it, then /clear.", "warn");
    }
    if (store.conversation()?.open) {
      busy.current = true;
      try {
        await tune.holdingSwitch(closeConversation);
      } finally {
        busy.current = false;
      }
    }
    history.current = [];
    ctrlCAt.current = 0;
    cancelWhenStarted.current = false;
    setText("");
    setHint(null);
    setScreen(null);
    setSubview(null);
    setFocus("prompt");
    setPanel({ selected: 0, open: {} });
    setScroll(0);
    setFull(false);
    setModeOverride(null);
    setRunChoice("auto");
    store.clear();
    store.note("New session.", "info");
    const switched = tune.conversationEnded();
    if (switched !== null) store.note(switched, "info");
  };

  const submit = async (value: string) => {
    const typed = value.trim();
    if (!typed || busy.current) return;
    if (typed.startsWith("/")) {
      const [word, after] = typed.slice(1).split(/\s+/);
      const name = (word ?? "").toLowerCase();
      const arg = (after ?? "").toLowerCase(); // the word after the name: /tune on, /tune off; other commands ignore it
      if (name === "quit") return void quit();
      if (name === "clear") return void clear();
      if (!COMMANDS.some((c) => c.name === name)) return store.note(`Unknown command /${name}. /help lists the commands.`, "warn");
      history.current = [...history.current, typed].slice(-HISTORY_MAX);
      setText("");
      if (name === "tune" && arg === "off") {
        // no screen: off at once, and a note of what it cancelled
        void tune.turnOff().then(
          (line) => store.note(line, "info"),
          (err: unknown) => store.note(`Turning tuning off failed: ${messageOf(err)}`, "error"),
        );
        return;
      }
      setScreenArg(arg);
      setScreen(name);
      return;
    }
    const exited = store.snapshot().engineExit;
    if (exited) return store.note(engineStoppedMessage(exited.code), "error");
    if (isActive(store.live().phase)) return store.note("A run is active. Esc cancels it.", "warn");
    const mentioned = mentionPaths(typed, deps.cwd);
    if (!mentioned.ok) return store.note(mentioned.error, "error");
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
        if ((await deps.keys.resolve(rootProvider)) === null) {
          store.note(`No key for ${def.name}. Use /providers.`, "warn");
          setScreen("providers");
          return;
        }
      } catch (err) {
        return store.note(`Could not read the saved key for ${def.name}: ${messageOf(err)}`, "error");
      } finally {
        busy.current = false;
      }
    }
    /** v0's start flow: parse, the repo checks, then a fresh run. */
    const fresh = (notes: string[] = []) => {
      const parsed = parseQuestion(typed, deps.cwd, undefined, runChoice);
      if (!parsed.ok) {
        for (const n of notes) store.note(n, "info");
        return store.note(parsed.error, "error");
      }
      const run = parsed.run;
      const warnings: string[] = [];
      if (run.mode === "repo") {
        if (!inGitRepo(deps.cwd)) warnings.push(`No git repository in ${deps.cwd} or its parents, so diff() will be unavailable.`);
        if (veryLarge(deps.cwd)) {
          for (const n of notes) store.note(n, "info");
          setConfirm({ text: "This folder is very large. Run on it anyway? y/N", onYes: () => void start(run, typed, warnings, notes) });
          return;
        }
      }
      void start(run, typed, warnings, notes);
    };
    const conv = store.conversation();
    const refs = settingsRefs(settings);
    if (
      conv &&
      settings.conversation.follow_ups &&
      refs.root &&
      refs.sub &&
      continues(
        conv,
        { mentions: mentioned.paths, choice: runChoice },
        { root: refKey(refs.root), sub: refKey(refs.sub), profile: settings.profile, permissionMode: nextMode, folder: deps.cwd },
      )
    ) {
      // the text sent: the typed text, or with mentions the run's own question or task (their `@` and quotes dropped)
      let text = typed;
      if (mentioned.paths.length > 0) {
        const parsed = parseQuestion(typed, deps.cwd, undefined, runChoice);
        if (parsed.ok) text = (parsed.run.mode === "read" ? parsed.run.question : parsed.run.task) ?? typed;
      }
      return followUp(conv.runId, text, typed, () => fresh([CONVERSATION_ENDED]));
    }
    fresh();
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
  const menusFree = !screen && !subview && keyboardFree && focus === "prompt";
  const menu = menusFree ? slashMatches(text) : [];
  const mention = menusFree && text !== filesClosedAt ? (mentionToken(text)?.typed ?? null) : null;
  const files = useMemo(() => (mention === null ? [] : rankFiles(mention, listFiles(deps.cwd))), [mention, deps.cwd]);
  const showPanel = !screen && !subview && view.blocks.length > 0;
  const wantApproval = head ? approvalHeight(head, size.columns) : confirm ? 3 : 0;
  const h = layoutHeights(size.rows, { panel: showPanel, approval: wantApproval, menu: Math.min(menu.length || files.length, MENU_MAX) });
  const mainHeight = h.transcript + h.panel;
  const lines = useMemo(() => {
    if (view.entries.length === 0 && view.phase === "idle") {
      const s = deps.session.settings;
      return bannerLines({ app: APP_VERSION, engine: engineVersion, folder: deps.cwd, root: s.root.model || "none (use /model)", sub: s.sub.model || "same", followUps: s.conversation.follow_ups }, size.columns);
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
      if (files.length > 0) return setFilesClosedAt(text);
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
  const placeholder = engineGone ? engineStoppedMessage(view.engineExit!.code) : (hint ?? (isActive(view.phase) ? "A run is active; Esc cancels it." : HINT[runChoice]));

  let main;
  if (command) {
    main = (
      <command.Screen
        deps={deps}
        store={store}
        view={view}
        close={closeScreen}
        permissionMode={nextMode}
        setPermissionMode={setModeOverride}
        active={keyboardFree}
        width={size.columns}
        height={mainHeight}
        arg={screenArg}
        tune={tune}
        closeConversation={closeConversation}
      />
    );
  } else if (row) {
    main = (
      <SubcallView
        key={row.key}
        row={row}
        block={blockOfRow(view.blocks, row.key)}
        cellCode={rowCellCode(view.blocks, row, view.cellCode)}
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
          files={files}
          menuHeight={h.menu}
          cwd={deps.cwd}
          history={history.current}
          onFocusPanel={() => {
            if (view.blocks.length > 0) setFocus("panel");
          }}
          onCycleRunChoice={() => setRunChoice((c) => RUN_CHOICES[(RUN_CHOICES.indexOf(c) + 1) % RUN_CHOICES.length]!)}
        />
        <StatusLine segments={statusModel(view, deps, nextMode, runChoice, tune.status())} width={size.columns} />
      </Box>
    </ThemeContext.Provider>
  );
}

/** Bare `rlmh`: render the app and wait until it exits. Ctrl+C is the app's own (cancel a run, or twice to quit). */
export async function runApp(deps: AppDeps): Promise<void> {
  const instance = render(<App deps={deps} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
}
