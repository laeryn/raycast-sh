import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Emulator } from "../src/lib/emulator";
import * as pty from "../src/lib/pty";
import { renderSvg } from "../src/lib/svg";

// Usage: just smoke  — drives real shells through the emulator and writes SVG screens to $OUT (default .smoke/).
const OUT = process.env.OUT || join(process.cwd(), ".smoke");
mkdirSync(OUT, { recursive: true });
const ROOT = join(OUT, "sessions");
const REPO = process.cwd();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeSession(name: string, cols: number, rows: number, shell = "/bin/zsh"): string {
  const dir = join(ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync("/usr/bin/mkfifo", [join(dir, "in")]);
  closeSync(openSync(join(dir, "out"), "w"));
  pty.startBroker({
    dir, brokerPath: join(REPO, "assets/pty-broker.py"), cols, rows, cwd: REPO,
    argv: [shell, "-l", "-i"],
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "sh-raycast" },
  });
  return dir;
}

function dump(emu: Emulator, name: string, title: string, live = false) {
  const svg = renderSvg(emu.screen(), { title, live });
  writeFileSync(join(OUT, `${name}.svg`), svg);
  console.log(`${name}.svg ${svg.length} bytes; cursor`, emu.screen().cursor, "title:", emu.title);
}

async function main() {
  const dir = makeSession("a", 80, 28);
  await sleep(1500);
  // Attach after the shell already printed its prompt: exercises replay.
  const emu = new Emulator(dir);
  await emu.start();
  console.log("replayed, size", emu.cols, emu.rows, "ready", emu.ready);
  pty.send(dir, "ls --color=always -la /usr/bin | head -8; printf '\\e[31mred\\e[0m \\e[1;32mbold green\\e[0m \\e[4munder\\e[0m \\e[7minverse\\e[0m \\e[38;5;208m208\\e[0m \\e[38;2;100;200;255mtruecolor\\e[0m \\e[9mstrike\\e[0m \\e[2mdim\\e[0m 宽字符 ✓ ok\\n'; echo https://example.com/path.\r");
  await sleep(1200);
  dump(emu, "01-shell", "zsh — raycast-sh", true);
  console.log("urls", emu.urls());
  console.log(emu.screenText().split("\n").slice(-6).join("\n"));

  pty.send(dir, "vim -u NONE -N README.md\r");
  await sleep(1500);
  pty.send(dir, ":set number\r");
  await sleep(500);
  dump(emu, "02-vim", "vim");
  console.log("appCursor", emu.modes.applicationCursorKeysMode, "bracketed", emu.modes.bracketedPasteMode);
  pty.send(dir, "\x1b:q!\r");
  await sleep(600);

  pty.send(dir, "top -l 1 -n 10 | head -25\r");
  await sleep(2500);
  dump(emu, "03-top", "top");

  // scrollback
  pty.send(dir, "seq 1 200\r");
  await sleep(800);
  emu.scrollBy(50);
  dump(emu, "04-scrolled", "zsh");
  emu.scrollToBottom();

  // resize
  emu.resize(100, 34);
  await sleep(500);
  pty.send(dir, "stty size; clear; printf '\\e]0;custom title\\a'; echo resized\r");
  await sleep(800);
  dump(emu, "05-resized", emu.title || "zsh");
  console.log("size file:", readFileSync(join(dir, "size"), "utf8"));

  // htop-ish full screen with colors: watch-like python curses? use 'less'
  pty.send(dir, "ls -la --color=always /etc | less -R\r");
  await sleep(1000);
  dump(emu, "06-less", "less");
  pty.send(dir, "q");
  await sleep(300);
  pty.send(dir, "exit 3\r");
  await sleep(800);
  console.log("alive", pty.isAlive(dir), "exit", pty.exitCode(dir));
  emu.dispose();
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
