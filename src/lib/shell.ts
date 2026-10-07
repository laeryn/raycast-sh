import { getPreferenceValues, LocalStorage } from "@raycast/api";
import { homedir } from "node:os";
import { basename } from "node:path";

export function getShell(): string {
  const { shell } = getPreferenceValues<Preferences>();
  return shell?.trim() || process.env.SHELL || "/bin/zsh";
}

export function getWorkingDirectory(): string {
  const { workingDirectory } = getPreferenceValues<Preferences>();
  return workingDirectory?.trim() || homedir();
}

export function shellKind(shell: string): "zsh" | "bash" | "fish" | "sh" {
  const name = basename(shell);
  if (name.includes("zsh")) return "zsh";
  if (name.includes("bash")) return "bash";
  if (name.includes("fish")) return "fish";
  return "sh";
}

/** Environment for child shells: keep the user's env but stop pagers and fancy terminal output from hanging or garbling things. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    MANPAGER: "cat",
    LANG: process.env.LANG || "en_US.UTF-8",
    ...extra,
  };
}

/** Wrap text in a markdown code fence that's longer than any backtick run inside it. */
export function codeBlock(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

const HISTORY_KEY = "history";
const HISTORY_LIMIT = 200;

export async function loadHistory(): Promise<string[]> {
  const raw = await LocalStorage.getItem<string>(HISTORY_KEY);
  try {
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export async function addToHistory(command: string): Promise<string[]> {
  const history = [command, ...(await loadHistory()).filter((c) => c !== command)].slice(0, HISTORY_LIMIT);
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  return history;
}

export async function removeFromHistory(command: string): Promise<string[]> {
  const history = (await loadHistory()).filter((c) => c !== command);
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  return history;
}

export async function clearHistory(): Promise<void> {
  await LocalStorage.removeItem(HISTORY_KEY);
}
