import { Action, ActionPanel, Clipboard, Keyboard, LaunchProps, List, open, showToast, Toast } from "@raycast/api";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { useCallback, useEffect, useRef, useState } from "react";
import { Emulator } from "./lib/emulator";
import { glyph, GlyphName } from "./lib/icons";
import * as session from "./lib/session";
import { renderSvg, svgToMarkdown } from "./lib/svg";
import { DEFAULT_SIZE_INDEX, loadLive, loadSizeIndex, saveLive, saveSizeIndex, SIZES } from "./lib/terminal-prefs";

const FRAME_MS = 100;
const LIST_REFRESH_MS = 1000;
const NEW_SESSION_ID = "__new__";
// Live mode keeps one space in the search bar so a backspace on an "empty" bar is still visible to us.
const SENTINEL = " ";
const LIVE_RESET_LENGTH = 24;
const LIVE_IDLE_MS = 400;

const ctrl = (letter: string) => String.fromCharCode(letter.charCodeAt(0) - 96);

type Props = LaunchProps<{ launchContext: { sessionId?: string } }>;

export default function Command(props: Props) {
  const [sessions, setSessions] = useState<session.SessionInfo[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [searchText, setSearchText] = useState("");
  const [live, setLive] = useState(false);
  const [sizeIndex, setSizeIndex] = useState(DEFAULT_SIZE_INDEX);
  const [markdown, setMarkdown] = useState("");
  const [busy, setBusy] = useState(true);

  const emulator = useRef<Emulator | null>(null);
  const liveRef = useRef(false);
  const prevLiveText = useRef(SENTINEL);
  const idleTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const lastFrame = useRef("");

  const size = SIZES[sizeIndex];
  const selected = sessions?.find((s) => s.id === selectedId);

  const refreshSessions = useCallback(() => {
    const list = session.listSessions();
    setSessions(list);
    return list;
  }, []);

  // Startup: restore prefs, then pick (or create) a session.
  useEffect(() => {
    (async () => {
      const [index, isLive] = await Promise.all([loadSizeIndex(), loadLive()]);
      setSizeIndex(index);
      setLiveMode(isLive);
      const list = refreshSessions();
      const wanted = props.launchContext?.sessionId;
      const target = list.find((s) => s.id === wanted) ?? list.filter((s) => s.alive).pop() ?? list.pop();
      setSelectedId(target ? target.id : await session.createSession(SIZES[index]));
      refreshSessions();
      setBusy(false);
    })();
    const timer = setInterval(refreshSessions, LIST_REFRESH_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(idleTimer.current);
      emulator.current?.dispose();
      emulator.current = null;
    };
  }, []);

  // Attach an emulator to the selected session; only the selected one is kept running.
  useEffect(() => {
    if (!selectedId || selectedId === NEW_SESSION_ID) return;
    const emu = new Emulator(session.sessionDir(selectedId));
    emulator.current?.dispose();
    emulator.current = emu;
    lastFrame.current = "";
    emu.start().then(() => {
      if (emulator.current === emu && session.isAlive(selectedId)) emu.resize(size.cols, size.rows);
    });
    return () => {
      if (emulator.current === emu) {
        emu.dispose();
        emulator.current = null;
      }
    };
  }, [selectedId]);

  // Draw a frame whenever the screen, or anything shown in its header, changes.
  useEffect(() => {
    const timer = setInterval(() => {
      const emu = emulator.current;
      if (!emu || !emu.ready || !selected) return;
      const title = titleFor(selected, emu);
      const status = selected.alive ? undefined : `exited ${selected.exitCode ?? "?"}`;
      const key = `${emu.version}|${live}|${status}|${title}`;
      if (key === lastFrame.current) return;
      lastFrame.current = key;
      setMarkdown(svgToMarkdown(renderSvg(emu.screen(), { title, live, status }), title));
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [selected, live]);

  // --- input ---------------------------------------------------------------------------------------

  const send = useCallback(
    (data: string) => {
      if (!selectedId || !data) return;
      if (!session.isAlive(selectedId)) {
        showToast({ style: Toast.Style.Failure, title: "Session ended", message: "Restart it with ⌘R" });
        return;
      }
      emulator.current?.scrollToBottom();
      session.send(selectedId, data);
      setTimeout(() => emulator.current?.poll(), 25); // snappier echo than waiting for the timer
    },
    [selectedId],
  );

  function setLiveMode(on: boolean) {
    liveRef.current = on;
    setLive(on);
    prevLiveText.current = SENTINEL;
    setSearchText(on ? SENTINEL : "");
  }

  function resetLiveBar() {
    prevLiveText.current = SENTINEL;
    setSearchText(SENTINEL);
  }

  /** In live mode, turn each change of the search bar into the keystrokes that produced it. */
  function onSearchTextChange(value: string) {
    if (!liveRef.current) {
      setSearchText(value);
      return;
    }
    const prev = prevLiveText.current;
    let data: string;
    let next = value;
    if (value === "") {
      data = "\x7f"; // backspace on the sentinel
      next = SENTINEL;
    } else if (value.startsWith(prev)) {
      data = value.slice(prev.length);
    } else if (prev.startsWith(value)) {
      data = "\x7f".repeat(prev.length - value.length);
    } else {
      let common = 0;
      while (common < prev.length && common < value.length && prev[common] === value[common]) common++;
      data = "\x7f".repeat(prev.length - common) + value.slice(common);
    }
    if (next.length > LIVE_RESET_LENGTH) next = SENTINEL;
    send(data);
    prevLiveText.current = next;
    setSearchText(next);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(resetLiveBar, LIVE_IDLE_MS);
  }

  function submit() {
    if (live) {
      send("\r");
      resetLiveBar();
    } else {
      send(searchText + "\r");
      setSearchText("");
    }
  }

  function typeWithoutEnter() {
    send(searchText);
    setSearchText("");
  }

  // vim, less etc. switch the terminal to application cursor mode, where arrows are ESC O x.
  const arrow = (key: "A" | "B" | "C" | "D") =>
    send((emulator.current?.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[") + key);

  async function paste() {
    const text = await Clipboard.readText();
    if (!text) return;
    send(emulator.current?.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text);
  }

  // --- sessions ------------------------------------------------------------------------------------

  async function newSession(command?: string) {
    setBusy(true);
    const id = await session.createSession({ ...size, command: command || undefined });
    refreshSessions();
    setSelectedId(id);
    setBusy(false);
  }

  async function restart() {
    if (!selectedId) return;
    setBusy(true);
    await session.restartSession(selectedId, size.cols, size.rows);
    await emulator.current?.reload();
    refreshSessions();
    setBusy(false);
  }

  async function closeSession() {
    if (!selectedId) return;
    setBusy(true);
    emulator.current?.dispose();
    emulator.current = null;
    await session.remove(selectedId);
    const list = refreshSessions();
    setSelectedId(list.filter((s) => s.alive).pop()?.id ?? list.pop()?.id);
    setMarkdown("");
    setBusy(false);
  }

  function cycleSession(step: number) {
    if (!sessions?.length) return;
    const index = sessions.findIndex((s) => s.id === selectedId);
    setSelectedId(sessions[(index + step + sessions.length) % sessions.length].id);
  }

  async function zoom(index: number) {
    const next = Math.max(0, Math.min(SIZES.length - 1, index));
    setSizeIndex(next);
    await saveSizeIndex(next);
    if (selectedId && session.isAlive(selectedId)) emulator.current?.resize(SIZES[next].cols, SIZES[next].rows);
  }

  // --- view ----------------------------------------------------------------------------------------

  const emu = emulator.current;
  const urls = emu?.ready ? emu.urls() : [];
  const halfScreen = Math.ceil(size.rows / 2);

  const key = (title: string, data: string | (() => void), icon: GlyphName, shortcut?: Keyboard.Shortcut) => (
    <Action
      key={title}
      title={title}
      icon={glyph(icon)}
      shortcut={shortcut}
      onAction={() => (typeof data === "function" ? data() : send(data))}
    />
  );

  const actions = (
    <ActionPanel>
      <ActionPanel.Section>
        <Action title={!live && searchText ? "Send Command" : "Send ↵"} icon={glyph("return")} onAction={submit} />
        {!live &&
          key("Type Without ↵", typeWithoutEnter, "prompt", {
            modifiers: ["cmd"],
            key: "enter",
          })}
        <Action
          title={live ? "Switch to Line Mode" : "Switch to Live Typing"}
          icon={glyph("live", "coral")}
          shortcut={{ modifiers: ["cmd"], key: "l" }}
          onAction={async () => {
            setLiveMode(!live);
            await saveLive(!live);
          }}
        />
      </ActionPanel.Section>
      <ActionPanel.Section title="Keys">
        <Action
          title="Interrupt (⌃C)"
          icon={glyph("interrupt", "coral")}
          shortcut={{ modifiers: ["ctrl"], key: "c" }}
          onAction={() => send(ctrl("c"))}
        />
        {key("End of Input (⌃D)", ctrl("d"), "eof", { modifiers: ["ctrl"], key: "d" })}
        {key("Tab (⌃I)", "\t", "tab", { modifiers: ["ctrl"], key: "i" })}
        {key("Escape (⌃[)", "\x1b", "escape", { modifiers: ["ctrl"], key: "[" })}
        {key("Backspace", "\x7f", "eraser", { modifiers: ["shift"], key: "backspace" })}
        {key("Up", () => arrow("A"), "arrows", { modifiers: ["opt"], key: "arrowUp" })}
        {key("Down", () => arrow("B"), "arrows", { modifiers: ["opt"], key: "arrowDown" })}
        {key("Right", () => arrow("C"), "arrows", { modifiers: ["opt"], key: "arrowRight" })}
        {key("Left", () => arrow("D"), "arrows", { modifiers: ["opt"], key: "arrowLeft" })}
        {key("Page Up", "\x1b[5~", "arrows", { modifiers: ["opt", "shift"], key: "arrowUp" })}
        {key("Page Down", "\x1b[6~", "arrows", { modifiers: ["opt", "shift"], key: "arrowDown" })}
        {key("Home", "\x1b[H", "arrows", { modifiers: ["opt", "shift"], key: "arrowLeft" })}
        {key("End", "\x1b[F", "arrows", { modifiers: ["opt", "shift"], key: "arrowRight" })}
        {key("Suspend (⌃Z)", ctrl("z"), "pause", { modifiers: ["ctrl"], key: "z" })}
        {key("Clear (⌃L)", ctrl("l"), "eraser", { modifiers: ["ctrl"], key: "l" })}
        {key("Search History (⌃R)", ctrl("r"), "history", { modifiers: ["ctrl"], key: "r" })}
        <ActionPanel.Submenu title="Special Keys" icon={glyph("keyboard")}>
          {key("Shift-Tab", "\x1b[Z", "tab")}
          {key("Delete Forward", "\x1b[3~", "eraser")}
          {key("Insert", "\x1b[2~", "keyboard")}
          {key("Yes (Y ↵)", "y\r", "check")}
          {key("No (N ↵)", "n\r", "xmark")}
          {["P", "Q", "R", "S"].map((k, i) => key(`F${i + 1}`, `\x1bO${k}`, "keyboard"))}
          {["15", "17", "18", "19", "20", "21", "23", "24"].map((k, i) => key(`F${i + 5}`, `\x1b[${k}~`, "keyboard"))}
        </ActionPanel.Submenu>
      </ActionPanel.Section>
      <ActionPanel.Section title="Control Keys">
        {"abefghjknopqstuvwxy".split("").map((letter) =>
          key(`⌃${letter.toUpperCase()}`, ctrl(letter), "keyboard", {
            modifiers: ["ctrl"],
            key: letter as Keyboard.KeyEquivalent,
          }),
        )}
      </ActionPanel.Section>
      <ActionPanel.Section title="View">
        {key("Scroll Up", () => emu?.scrollBy(halfScreen), "scroll", { modifiers: ["cmd"], key: "arrowUp" })}
        {key("Scroll Down", () => emu?.scrollBy(-halfScreen), "scroll", { modifiers: ["cmd"], key: "arrowDown" })}
        {key("Scroll to Top", () => emu?.scrollToTop(), "scroll", { modifiers: ["cmd", "shift"], key: "arrowUp" })}
        {key("Scroll to Bottom", () => emu?.scrollToBottom(), "scroll", {
          modifiers: ["cmd", "shift"],
          key: "arrowDown",
        })}
        {key("Bigger Text", () => zoom(sizeIndex - 1), "zoom-in", { modifiers: ["cmd"], key: "=" })}
        {key("Smaller Text", () => zoom(sizeIndex + 1), "zoom-out", { modifiers: ["cmd"], key: "-" })}
        {key("Default Size", () => zoom(DEFAULT_SIZE_INDEX), "zoom-in", { modifiers: ["cmd"], key: "0" })}
      </ActionPanel.Section>
      <ActionPanel.Section title="Clipboard">
        {key("Paste Clipboard", paste, "clipboard", { modifiers: ["cmd", "shift"], key: "v" })}
        <Action.CopyToClipboard
          title="Copy Screen"
          icon={glyph("clipboard")}
          content={emu?.screenText() ?? ""}
          shortcut={Keyboard.Shortcut.Common.Copy}
        />
        {key(
          "Open Scrollback in Editor",
          () => {
            const file = join(tmpdir(), `sh-terminal-${Date.now()}.txt`);
            writeFileSync(file, emu?.allText() ?? "");
            open(file);
          },
          "document",
          { modifiers: ["cmd"], key: "o" },
        )}
        {urls.length > 0 && (
          <ActionPanel.Submenu
            title="Open Link on Screen"
            icon={glyph("link")}
            shortcut={Keyboard.Shortcut.Common.OpenWith}
          >
            {urls.map((url) => (
              <Action.OpenInBrowser key={url} url={url} title={url} icon={glyph("external")} />
            ))}
          </ActionPanel.Submenu>
        )}
      </ActionPanel.Section>
      <ActionPanel.Section title="Sessions">
        {key("New Session", () => newSession(), "session-new", { modifiers: ["cmd"], key: "n" })}
        {key("Next Session", () => cycleSession(1), "terminal-window", { modifiers: ["cmd", "shift"], key: "]" })}
        {key("Previous Session", () => cycleSession(-1), "terminal-window", {
          modifiers: ["cmd", "shift"],
          key: "[",
        })}
        {key("Restart Session", restart, "restart", { modifiers: ["cmd"], key: "r" })}
        <Action
          title="Close Session"
          icon={glyph("power", "coral")}
          style={Action.Style.Destructive}
          shortcut={{ modifiers: ["cmd", "shift"], key: "w" }}
          onAction={closeSession}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );

  return (
    <List
      isShowingDetail
      isLoading={busy || (!!selected && !emu?.ready)}
      filtering={false}
      searchText={searchText}
      onSearchTextChange={onSearchTextChange}
      searchBarPlaceholder={live ? "Live: keys go straight to the terminal" : "Type a command — ↵ to send"}
      selectedItemId={selectedId}
      onSelectionChange={(id) => {
        if (id && id !== selectedId) setSelectedId(id);
      }}
      navigationTitle="sh Terminal"
    >
      {(sessions ?? []).map((s) => (
        <List.Item
          key={s.id}
          id={s.id}
          icon={glyph("terminal-window", !s.alive ? "secondary" : s.id === selectedId ? "coral" : "primary")}
          title={titleFor(s, s.id === selectedId ? emu : null)}
          subtitle={shortPath(s.cwd)}
          accessories={s.alive ? [] : [{ tag: `exited ${s.exitCode ?? "?"}` }]}
          detail={<List.Item.Detail markdown={s.id === selectedId ? markdown : ""} />}
          actions={actions}
        />
      ))}
      <List.Item
        id={NEW_SESSION_ID}
        icon={glyph("session-new", "secondary")}
        title="New Session"
        detail={
          <List.Item.Detail
            markdown={
              "Press ↵ to start a new shell — or type a command first to start one running it.\n\nSessions keep running after you close Raycast."
            }
          />
        }
        actions={
          <ActionPanel>
            <Action
              title={searchText.trim() ? "Run in New Session" : "New Session"}
              icon={glyph("session-new")}
              onAction={() => {
                const command = live ? "" : searchText.trim();
                setSearchText(live ? SENTINEL : "");
                newSession(command);
              }}
            />
          </ActionPanel>
        }
      />
    </List>
  );
}

/** A running program's name (vim, htop) wins; otherwise the shell's own title (OSC), else the shell name. */
function titleFor(s: session.SessionInfo, emu: Emulator | null | undefined): string {
  const shell = basename(s.shell);
  if (s.process && s.process !== shell && !s.process.endsWith(shell)) return s.process;
  return emu?.title || shell;
}

function shortPath(path?: string): string | undefined {
  if (!path) return undefined;
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(home + "/") ? `~/${path.slice(home.length + 1)}` : path;
}
