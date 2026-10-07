import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  confirmAlert,
  Detail,
  getPreferenceValues,
  Keyboard,
  launchCommand,
  LaunchProps,
  LaunchType,
  List,
  open,
  useNavigation,
} from "@raycast/api";
import { ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showFailureToast } from "@raycast/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { glyph } from "./lib/icons";
import { openInTerminalApp } from "./lib/open-terminal";
import { renderTerminal } from "./lib/render";
import { createSession } from "./lib/session";
import { loadSizeIndex, SIZES } from "./lib/terminal-prefs";
import {
  addToHistory,
  childEnv,
  clearHistory,
  codeBlock,
  getShell,
  getWorkingDirectory,
  loadHistory,
  removeFromHistory,
  shellKind,
} from "./lib/shell";

export default function Command(props: LaunchProps<{ arguments: Arguments.Sh }>) {
  const initial = props.arguments.command?.trim();
  return initial ? <RunView command={initial} /> : <CommandPicker />;
}

function CommandPicker() {
  const [searchText, setSearchText] = useState("");
  const [history, setHistory] = useState<string[]>();
  const { push } = useNavigation();

  useEffect(() => {
    loadHistory().then(setHistory);
  }, []);

  const run = (command: string) => push(<RunView command={command} onRun={setHistory} />);
  const typed = searchText.trim();
  const matches = (history ?? []).filter((c) => c.toLowerCase().includes(typed.toLowerCase()) && c !== typed);

  return (
    <List
      isLoading={history === undefined}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      filtering={false}
      searchBarPlaceholder="Type a shell command and press ↵"
    >
      {typed && (
        <List.Item
          icon={glyph("prompt")}
          title={typed}
          subtitle="Run"
          actions={
            <ActionPanel>
              <Action title="Run Command" icon={glyph("run")} onAction={() => run(typed)} />
              <RunInShTerminalAction command={typed} />
              <RunInTerminalAction command={typed} />
            </ActionPanel>
          }
        />
      )}
      <List.Section title="History">
        {matches.map((command) => (
          <List.Item
            key={command}
            icon={glyph("history", "secondary")}
            title={command}
            actions={
              <ActionPanel>
                <Action title="Run Command" icon={glyph("run")} onAction={() => run(command)} />
                <Action
                  title="Edit Command"
                  icon={glyph("edit")}
                  shortcut={Keyboard.Shortcut.Common.Edit}
                  onAction={() => setSearchText(command)}
                />
                <Action.CopyToClipboard title="Copy Command" content={command} />
                <Action
                  title="Remove from History"
                  icon={glyph("trash", "coral")}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={async () => setHistory(await removeFromHistory(command))}
                />
                <Action
                  title="Clear History"
                  icon={glyph("clear", "coral")}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
                  onAction={async () => {
                    if (
                      await confirmAlert({
                        title: "Clear all history?",
                        primaryAction: { title: "Clear", style: Alert.ActionStyle.Destructive },
                      })
                    ) {
                      await clearHistory();
                      setHistory([]);
                    }
                  }}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      {!typed && history?.length === 0 && (
        <List.EmptyView
          icon={glyph("prompt", "secondary")}
          title="Type a command"
          description="Runs in your shell; output shows here."
        />
      )}
    </List>
  );
}

type Status = { state: "running" } | { state: "done"; code: number | null; signal: NodeJS.Signals | null };

const MAX_BUFFER = 1024 * 1024; // keep at most 1 MB of raw output
const MAX_DISPLAY = 100_000; // Raycast gets sluggish rendering much more markdown than this

function RunView({ command, onRun }: { command: string; onRun?: (history: string[]) => void }) {
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState<Status>({ state: "running" });
  const [startedAt, setStartedAt] = useState(Date.now());
  const [endedAt, setEndedAt] = useState<number>();
  const [runId, setRunId] = useState(0);
  const child = useRef<ChildProcess | null>(null);
  const cwd = getWorkingDirectory();

  useEffect(() => {
    addToHistory(command).then((h) => onRun?.(h));

    const { loadRcFiles } = getPreferenceValues<Preferences>();
    const shell = getShell();
    // fish has no useful -i for -c; everything else loads aliases from the interactive rc file with -i.
    const flags = loadRcFiles && shellKind(shell) !== "fish" ? ["-l", "-i", "-c"] : ["-l", "-c"];
    let raw = "";
    let pending = false;
    const flush = () => {
      pending = false;
      setOutput(renderTerminal(raw));
    };
    const onData = (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > MAX_BUFFER) raw = raw.slice(-MAX_BUFFER);
      if (!pending) {
        pending = true;
        setTimeout(flush, 80);
      }
    };

    setOutput("");
    setStatus({ state: "running" });
    setStartedAt(Date.now());
    setEndedAt(undefined);

    // detached = own process group, so Stop can kill the whole pipeline.
    const proc = spawn(shell, [...flags, command], {
      cwd,
      env: childEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.current = proc;
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (err) => {
      raw += `\n${err.message}\n`;
      flush();
    });
    proc.on("close", (code, signal) => {
      child.current = null;
      flush();
      setEndedAt(Date.now());
      setStatus({ state: "done", code, signal });
    });

    return () => kill(proc);
  }, [command, runId]);

  const stop = useCallback(() => child.current && kill(child.current), []);
  const running = status.state === "running";
  const elapsed = ((endedAt ?? Date.now()) - startedAt) / 1000;

  const shown = output.length > MAX_DISPLAY ? output.slice(-MAX_DISPLAY) : output;
  const truncatedNote =
    output.length > MAX_DISPLAY ? "_Showing the last 100k characters — open in an editor to see everything._\n\n" : "";
  const markdown = `${truncatedNote}${codeBlock(shown || (running ? "…" : "(no output)"))}`;

  return (
    <Detail
      isLoading={running}
      navigationTitle={command}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Command" text={command} />
          <Detail.Metadata.TagList title="Status">
            <Detail.Metadata.TagList.Item {...statusTag(status)} />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Label title="Duration" text={running ? "running…" : `${elapsed.toFixed(2)}s`} />
          <Detail.Metadata.Label title="Lines" text={String(output ? output.split("\n").length : 0)} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="Directory" text={cwd} />
          <Detail.Metadata.Label title="Shell" text={getShell()} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Output" content={output} />
          {running && (
            <Action
              title="Stop"
              icon={glyph("stop", "coral")}
              style={Action.Style.Destructive}
              shortcut={Keyboard.Shortcut.Common.Pin}
              onAction={stop}
            />
          )}
          <Action
            title="Run Again"
            icon={glyph("repeat")}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={() => setRunId((n) => n + 1)}
          />
          <Action
            title="Paste Output"
            icon={glyph("clipboard")}
            shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
            onAction={() => Clipboard.paste(output)}
          />
          <Action
            title="Open Output in Editor"
            icon={glyph("document")}
            shortcut={Keyboard.Shortcut.Common.Open}
            onAction={() => {
              const file = join(tmpdir(), `sh-output-${Date.now()}.txt`);
              writeFileSync(file, output);
              open(file);
            }}
          />
          <RunInShTerminalAction command={command} />
          <RunInTerminalAction command={command} />
          <Action.CopyToClipboard title="Copy Command" content={command} shortcut={Keyboard.Shortcut.Common.Copy} />
        </ActionPanel>
      }
    />
  );
}

function kill(proc: ChildProcess) {
  if (proc.pid === undefined || proc.exitCode !== null) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
}

function statusTag(status: Status): { text: string; color: string } {
  if (status.state === "running") return { text: "Running", color: "#56c2ff" };
  if (status.signal) return { text: `Killed (${status.signal})`, color: "#ffc533" };
  return status.code === 0 ? { text: "Exit 0", color: "#59d499" } : { text: `Exit ${status.code}`, color: "#ff6363" };
}

/** Run the command in a new sh Terminal session, for anything interactive. */
function RunInShTerminalAction({ command }: { command: string }) {
  return (
    <Action
      title="Run in Sh Terminal"
      icon={glyph("terminal-window", "coral")}
      shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
      onAction={async () => {
        const sessionId = await createSession({ ...SIZES[await loadSizeIndex()], command });
        await launchCommand({ name: "terminal", type: LaunchType.UserInitiated, context: { sessionId } });
      }}
    />
  );
}

/** Open the command in the user's terminal app (Ghostty by default when installed). */
function RunInTerminalAction({ command }: { command: string }) {
  return (
    <Action
      title="Run in Terminal App"
      icon={glyph("external")}
      shortcut={{ modifiers: ["cmd", "shift"], key: "enter" }}
      onAction={async () => {
        try {
          await openInTerminalApp(command);
        } catch (error) {
          await showFailureToast(error, { title: "Couldn't open the terminal app" });
        }
      }}
    />
  );
}
