// Low-level access to one pty-broker session directory (see assets/pty-broker.py).
// No @raycast/api imports here, so this file can be exercised from plain Node.

import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export type Size = { cols: number; rows: number };

const file = (dir: string, name: string) => join(dir, name);

function readText(dir: string, name: string): string | undefined {
  try {
    return readFileSync(file(dir, name), "utf8").trim();
  } catch {
    return undefined;
  }
}

/** The broker's pid, if it is still running. */
export function brokerPid(dir: string): number | undefined {
  const pid = Number(readText(dir, "pid"));
  if (!pid) return undefined;
  try {
    process.kill(pid, 0); // throws if the process is gone
    return pid;
  } catch {
    return undefined;
  }
}

export function isAlive(dir: string): boolean {
  return brokerPid(dir) !== undefined;
}

export function exitCode(dir: string): number | undefined {
  const text = readText(dir, "exit");
  return text === undefined || text === "" ? undefined : Number(text);
}

export function readSize(dir: string): Size | undefined {
  const [cols, rows] = (readText(dir, "size") ?? "").split(/\s+/).map(Number);
  return cols > 0 && rows > 0 ? { cols, rows } : undefined;
}

export function ttyName(dir: string): string | undefined {
  return readText(dir, "tty") || undefined;
}

export function shellPid(dir: string): number | undefined {
  return Number(readText(dir, "child")) || undefined;
}

/** Tell the broker about a new terminal size (it applies it with TIOCSWINSZ, which SIGWINCHes the foreground job). */
export function resize(dir: string, cols: number, rows: number): void {
  writeFileSync(file(dir, "size"), `${cols} ${rows}`);
  const pid = brokerPid(dir);
  if (pid) process.kill(pid, "SIGUSR1");
}

export type StartOptions = {
  dir: string;
  brokerPath: string;
  cols: number;
  rows: number;
  cwd: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
};

/** Launch a detached broker in an already-prepared dir (must contain the `in` FIFO and an empty `out`). */
export function startBroker(options: StartOptions): void {
  const { dir, brokerPath, cols, rows, cwd, argv, env } = options;
  const child = spawn("/usr/bin/python3", [brokerPath, dir, String(cols), String(rows), cwd, ...argv], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
}

// Writes go to a non-blocking FIFO; if it is full (big paste into a busy program), queue the rest and retry.
const queues = new Map<string, Buffer[]>();

function flush(dir: string): void {
  const queue = queues.get(dir);
  if (!queue || queue.length === 0) return;
  const path = file(dir, "in");
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch {
    queues.delete(dir); // no reader: the broker is gone
    return;
  }
  try {
    while (queue.length > 0) {
      const chunk = queue[0];
      let written = 0;
      try {
        written = writeSync(fd, chunk);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") break;
        queues.delete(dir);
        return;
      }
      if (written < chunk.length) {
        queue[0] = chunk.subarray(written);
        break;
      }
      queue.shift();
    }
  } finally {
    closeSync(fd);
  }
  if (queue.length > 0) setTimeout(() => flush(dir), 20);
  else queues.delete(dir);
}

/** Type bytes into the terminal. */
export function send(dir: string, data: string | Buffer): void {
  if (data.length === 0 || !existsSync(file(dir, "in"))) return;
  const queue = queues.get(dir);
  const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  if (queue) {
    queue.push(chunk); // a retry is already scheduled
    return;
  }
  queues.set(dir, [chunk]);
  flush(dir);
}

export function transcriptSize(dir: string): number {
  try {
    return statSync(file(dir, "out")).size;
  } catch {
    return 0;
  }
}

/** Read transcript bytes in [from, to). */
export function readRange(dir: string, from: number, to: number): Buffer {
  if (to <= from) return Buffer.alloc(0);
  const buffer = Buffer.alloc(to - from);
  let fd: number;
  try {
    fd = openSync(file(dir, "out"), "r");
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const read = readSync(fd, buffer, 0, buffer.length, from);
    return read < buffer.length ? buffer.subarray(0, read) : buffer;
  } finally {
    closeSync(fd);
  }
}
