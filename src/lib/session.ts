import { environment } from "@raycast/api";
import { execFile, execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as pty from "./pty";
import { getShell, getWorkingDirectory } from "./shell";

// Each terminal session runs in its own detached pty broker (assets/pty-broker.py)
// under supportPath/sessions/<id>/, so sessions survive the Raycast window closing.

const ROOT = join(environment.supportPath, "sessions");
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
const INFO_TTL_MS = 2000;

export type SessionMeta = { id: string; shell: string; createdAt: number };

export type SessionInfo = SessionMeta & {
  dir: string;
  alive: boolean;
  exitCode?: number;
  size?: pty.Size;
  /** Foreground process name (e.g. "vim"), refreshed in the background at most every ~2s. */
  process?: string;
  /** Working directory of the shell. */
  cwd?: string;
};

export function sessionDir(id: string): string {
  return join(ROOT, id);
}

function readMeta(id: string): SessionMeta | undefined {
  try {
    return JSON.parse(readFileSync(join(sessionDir(id), "meta.json"), "utf8")) as SessionMeta;
  } catch {
    return undefined;
  }
}

/** Remove dead sessions that ended more than a day ago, plus the single-session dir from older versions. */
function prune(): void {
  const legacy = join(environment.supportPath, "session");
  if (existsSync(legacy) && !pty.isAlive(legacy)) rmSync(legacy, { recursive: true, force: true });
  if (!existsSync(ROOT)) return;
  const now = Date.now();
  for (const id of readdirSync(ROOT)) {
    const dir = sessionDir(id);
    if (pty.isAlive(dir)) continue;
    try {
      const ended = existsSync(join(dir, "exit")) ? statSync(join(dir, "exit")).mtimeMs : statSync(dir).mtimeMs;
      if (now - ended > PRUNE_AFTER_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // raced with another remove
    }
  }
}

let lastPrune = 0;

export function listSessions(): SessionInfo[] {
  if (Date.now() - lastPrune > 60_000) {
    lastPrune = Date.now();
    prune();
  }
  if (!existsSync(ROOT)) return [];
  const sessions: SessionInfo[] = [];
  for (const id of readdirSync(ROOT)) {
    const meta = readMeta(id);
    if (meta) sessions.push(getSession(meta));
  }
  return sessions.sort((a, b) => a.createdAt - b.createdAt);
}

function getSession(meta: SessionMeta): SessionInfo {
  const dir = sessionDir(meta.id);
  const alive = pty.isAlive(dir);
  const info = alive ? titleInfo(meta.id) : cachedInfo.get(meta.id)?.value;
  return {
    ...meta,
    dir,
    alive,
    exitCode: alive ? undefined : pty.exitCode(dir),
    size: pty.readSize(dir),
    process: info?.process,
    cwd: info?.cwd,
  };
}

/** Environment for the terminal's shell: a real, color-capable terminal. */
function terminalEnv(cols: number, rows: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "sh-raycast",
    LANG: process.env.LANG || "en_US.UTF-8",
    COLUMNS: String(cols),
    LINES: String(rows),
  };
  // Raycast's own environment may carry these; they'd confuse programs running in our pty.
  delete env.TERM_PROGRAM_VERSION;
  delete env.TERM_SESSION_ID;
  delete env.ITERM_SESSION_ID;
  delete env.NO_COLOR;
  return env;
}

function launch(id: string, cols: number, rows: number, shell: string): void {
  const dir = sessionDir(id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync("/usr/bin/mkfifo", [join(dir, "in")]);
  closeSync(openSync(join(dir, "out"), "w"));
  pty.startBroker({
    dir,
    brokerPath: join(environment.assetsPath, "pty-broker.py"),
    cols,
    rows,
    cwd: getWorkingDirectory(),
    argv: [shell, "-l", "-i"],
    env: terminalEnv(cols, rows),
  });
}

async function waitForOutput(id: string, timeoutMs = 3000): Promise<void> {
  const dir = sessionDir(id);
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    if (pty.transcriptSize(dir) > 0) break;
    await sleep(50);
  }
}

/** Start a new session. If `command` is given it is typed in (followed by ↵) once the shell is up. */
export async function createSession(options: { cols: number; rows: number; command?: string }): Promise<string> {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const shell = getShell();
  launch(id, options.cols, options.rows, shell);
  writeFileSync(join(sessionDir(id), "meta.json"), JSON.stringify({ id, shell, createdAt: Date.now() }));
  if (options.command) {
    await waitForOutput(id);
    await sleep(250); // let rc files finish before typing
    send(id, `${options.command}\r`);
  } else {
    await waitForOutput(id, 1000);
  }
  return id;
}

/** Stop the shell and start a fresh one in the same session slot. */
export async function restartSession(id: string, cols: number, rows: number): Promise<void> {
  const meta = readMeta(id);
  await stopAndWait(id);
  const shell = getShell();
  launch(id, cols, rows, shell);
  writeFileSync(
    join(sessionDir(id), "meta.json"),
    JSON.stringify({ id, shell, createdAt: meta?.createdAt ?? Date.now() }),
  );
  cachedInfo.delete(id);
  await waitForOutput(id, 1000);
}

export function send(id: string, data: string): void {
  pty.send(sessionDir(id), data);
}

export function resize(id: string, cols: number, rows: number): void {
  pty.resize(sessionDir(id), cols, rows);
}

export function isAlive(id: string): boolean {
  return pty.isAlive(sessionDir(id));
}

export function exitCode(id: string): number | undefined {
  return pty.exitCode(sessionDir(id));
}

export function stop(id: string): void {
  const pid = pty.brokerPid(sessionDir(id));
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM"); // the broker hangs up the shell
  } catch {
    // already gone
  }
}

async function stopAndWait(id: string): Promise<void> {
  stop(id);
  for (let waited = 0; waited < 1500 && isAlive(id); waited += 50) await sleep(50);
  const pid = pty.brokerPid(sessionDir(id));
  if (pid) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
}

/** Stop the session and delete its files. */
export async function remove(id: string): Promise<void> {
  await stopAndWait(id);
  rmSync(sessionDir(id), { recursive: true, force: true });
  cachedInfo.delete(id);
}

/** New transcript bytes from `offset` (see Emulator for the incremental reader). */
export function readOutput(id: string, offset: number): Buffer {
  const dir = sessionDir(id);
  return pty.readRange(dir, offset, pty.transcriptSize(dir));
}

// --- Title info: foreground process + cwd, polled lazily -------------------------------------------

type TitleInfo = { process?: string; cwd?: string };
const cachedInfo = new Map<string, { at: number; value: TitleInfo; pending: boolean }>();

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 1500 }, (error, stdout) => resolve(error && !stdout ? "" : String(stdout)));
  });
}

async function refreshInfo(id: string): Promise<TitleInfo> {
  const dir = sessionDir(id);
  const tty = pty.ttyName(dir);
  const shellPid = pty.shellPid(dir);
  const value: TitleInfo = {};
  if (tty) {
    const ps = await run("/bin/ps", ["-t", basename(tty), "-o", "pid=,stat=,comm="]);
    const foreground = ps
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => m !== null && m[2].includes("+"));
    // Prefer the job over the shell itself when something is running.
    const pick = foreground.filter((m) => Number(m[1]) !== shellPid).pop() ?? foreground.pop();
    if (pick) value.process = basename(pick[3].trim()).replace(/^-/, "");
  }
  if (shellPid) {
    const lsof = await run("/usr/sbin/lsof", ["-a", "-p", String(shellPid), "-d", "cwd", "-Fn"]);
    const line = lsof.split("\n").find((l) => l.startsWith("n"));
    if (line) value.cwd = line.slice(1);
  }
  return value;
}

/** Cached foreground process / cwd for a session; kicks off a background refresh when stale. */
export function titleInfo(id: string): TitleInfo {
  const entry = cachedInfo.get(id);
  if (!entry || (!entry.pending && Date.now() - entry.at > INFO_TTL_MS)) {
    const next = { at: entry?.at ?? 0, value: entry?.value ?? {}, pending: true };
    cachedInfo.set(id, next);
    refreshInfo(id)
      .then((value) => cachedInfo.set(id, { at: Date.now(), value, pending: false }))
      .catch(() => cachedInfo.set(id, { at: Date.now(), value: next.value, pending: false }));
  }
  return cachedInfo.get(id)?.value ?? {};
}
