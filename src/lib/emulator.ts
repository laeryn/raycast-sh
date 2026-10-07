// A real terminal emulator (@xterm/headless) fed from a broker session's transcript.
// No @raycast/api imports here, so it can be driven from plain Node for testing.

import { IBufferCell, Terminal } from "@xterm/headless";
import * as pty from "./pty";

export const ATTR = {
  bold: 1,
  dim: 2,
  italic: 4,
  underline: 8,
  strike: 16,
  inverse: 32,
  invisible: 64,
} as const;

/** Colors: -1 = default, 0..255 = palette index, RGB_FLAG | 0xRRGGBB = truecolor. */
export const RGB_FLAG = 0x1000000;

export type Cell = { chars: string; width: number; fg: number; bg: number; attrs: number };

export type Screen = {
  cols: number;
  rows: number;
  cells: Cell[][];
  cursor: { x: number; y: number; visible: boolean };
  /** Lines the viewport is scrolled up from the bottom. */
  scrolledBy: number;
};

const POLL_MS = 80;
const SCROLLBACK = 5000;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;

export class Emulator {
  readonly dir: string;
  term: Terminal;
  /** Bumped every time the screen may have changed; cheap change detection for renderers. */
  version = 0;
  title = "";
  bells = 0;
  /** True once the existing transcript has been replayed; device-query replies are only forwarded after this. */
  ready = false;

  private offset = 0;
  private tail = Buffer.alloc(0); // last bytes consumed, to resync after the broker rotates the transcript
  private timer: NodeJS.Timeout | undefined;
  private scroll = 0;
  private lastBaseY = 0;
  private disposed = false;
  private onReady: (() => void)[] = [];

  constructor(dir: string, size?: pty.Size) {
    this.dir = dir;
    this.term = this.createTerminal(size ?? pty.readSize(dir) ?? { cols: 80, rows: 28 });
  }

  private createTerminal(size: pty.Size): Terminal {
    const term = new Terminal({
      cols: size.cols,
      rows: size.rows,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
      convertEol: false,
    });
    term.onData((data) => this.ready && pty.send(this.dir, data));
    term.onBinary((data) => this.ready && pty.send(this.dir, Buffer.from(data, "binary")));
    term.onTitleChange((title) => {
      this.title = title;
      this.version++;
    });
    term.onBell(() => {
      if (this.ready) this.bells++;
    });
    term.onWriteParsed(() => {
      const base = term.buffer.active.baseY;
      // Keep a scrolled-back view anchored on the same content while new output arrives.
      if (this.scroll > 0 && base > this.lastBaseY) this.scroll = Math.min(base, this.scroll + base - this.lastBaseY);
      this.lastBaseY = base;
      this.version++;
    });
    return term;
  }

  /** Replay the whole transcript, then start following it. Resolves when the replay has been parsed. */
  start(): Promise<void> {
    const done = new Promise<void>((resolve) => this.onReady.push(resolve));
    this.replay();
    this.timer = setInterval(() => this.poll(), POLL_MS);
    return done;
  }

  private replay(): void {
    this.ready = false;
    const size = pty.transcriptSize(this.dir);
    const data = pty.readRange(this.dir, 0, size);
    this.offset = data.length;
    this.rememberTail(data);
    this.term.write(data, () => {
      if (this.disposed) return;
      this.ready = true;
      this.version++;
      for (const resolve of this.onReady.splice(0)) resolve();
    });
  }

  private rememberTail(data: Buffer): void {
    const keep = 512;
    this.tail = Buffer.concat([this.tail, data]).subarray(-keep);
    this.tail = Buffer.from(this.tail); // detach from the big read buffer
  }

  /** Read any new transcript bytes into the emulator. Called on a timer; call it directly after sending input for snappier echo. */
  poll(): void {
    if (this.disposed) return;
    const size = pty.transcriptSize(this.dir);
    if (size < this.offset) {
      // The broker rotated the transcript, keeping its tail. Find where we left off in it.
      const head = pty.readRange(this.dir, 0, size);
      const at = this.tail.length > 0 ? head.lastIndexOf(this.tail) : -1;
      if (at >= 0) {
        this.offset = at + this.tail.length;
      } else {
        this.term.reset();
        this.offset = 0;
      }
    }
    if (size <= this.offset) return;
    const data = pty.readRange(this.dir, this.offset, size);
    this.offset += data.length;
    this.rememberTail(data);
    this.term.write(data);
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  get modes() {
    return this.term.modes;
  }

  get cursorHidden(): boolean {
    // Not in the public API; reach into the core service, defensively.
    try {
      const core = (this.term as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core;
      return Boolean(core?.coreService?.isCursorHidden);
    } catch {
      return false;
    }
  }

  /** Resize the emulator and the pty. */
  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
    pty.resize(this.dir, cols, rows);
    this.scroll = Math.min(this.scroll, this.term.buffer.active.baseY);
    this.version++;
  }

  get scrolledBy(): number {
    return this.scroll;
  }

  /** Scroll the viewport by `lines` (positive = towards older output). */
  scrollBy(lines: number): void {
    const max = this.term.buffer.active.baseY;
    const next = Math.max(0, Math.min(max, this.scroll + lines));
    if (next !== this.scroll) {
      this.scroll = next;
      this.version++;
    }
  }

  scrollToBottom(): void {
    this.scrollBy(-this.scroll);
  }

  scrollToTop(): void {
    this.scrollBy(this.term.buffer.active.baseY);
  }

  screen(): Screen {
    const buffer = this.term.buffer.active;
    const { cols, rows } = this.term;
    const scrolledBy = Math.min(this.scroll, buffer.baseY);
    const top = buffer.baseY - scrolledBy;
    const cells: Cell[][] = [];
    let cell: IBufferCell | undefined = buffer.getNullCell();
    for (let y = 0; y < rows; y++) {
      const line = buffer.getLine(top + y);
      const row: Cell[] = [];
      for (let x = 0; x < cols; x++) {
        cell = line?.getCell(x, cell);
        if (!cell) {
          row.push({ chars: "", width: 1, fg: -1, bg: -1, attrs: 0 });
          continue;
        }
        row.push({
          chars: cell.getChars(),
          width: cell.getWidth(),
          fg: color(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor()),
          bg: color(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor()),
          attrs:
            (cell.isBold() ? ATTR.bold : 0) |
            (cell.isDim() ? ATTR.dim : 0) |
            (cell.isItalic() ? ATTR.italic : 0) |
            (cell.isUnderline() ? ATTR.underline : 0) |
            (cell.isStrikethrough() ? ATTR.strike : 0) |
            (cell.isInverse() ? ATTR.inverse : 0) |
            (cell.isInvisible() ? ATTR.invisible : 0),
        });
      }
      cells.push(row);
    }
    return {
      cols,
      rows,
      cells,
      cursor: {
        x: Math.min(buffer.cursorX, cols - 1),
        y: buffer.cursorY,
        visible: scrolledBy === 0 && !this.cursorHidden,
      },
      scrolledBy,
    };
  }

  /** Lines [from, to) of the active buffer as text, joining soft-wrapped lines. */
  private text(from: number, to: number): string[] {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = from; y < to; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines;
  }

  /** The visible screen as plain text. */
  screenText(): string {
    const buffer = this.term.buffer.active;
    const top = buffer.baseY - Math.min(this.scroll, buffer.baseY);
    return trimBlankTail(this.text(top, top + this.term.rows)).join("\n");
  }

  /** Scrollback plus screen as plain text. */
  allText(): string {
    return trimBlankTail(this.text(0, this.term.buffer.active.length)).join("\n");
  }

  /** http(s) URLs on the visible screen, deduplicated. */
  urls(): string[] {
    const found = new Set<string>();
    for (const match of this.screenText().matchAll(URL_RE)) {
      found.add(match[0].replace(/[.,;:!?)\]}>'"]+$/, ""));
    }
    return [...found];
  }

  /** Wipe the emulator and replay the transcript from scratch (e.g. after the session restarted). */
  reload(): Promise<void> {
    const done = new Promise<void>((resolve) => this.onReady.push(resolve));
    this.term.reset();
    this.scroll = 0;
    this.tail = Buffer.alloc(0);
    this.title = "";
    this.replay();
    return done;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.term.dispose();
  }
}

function color(isDefault: boolean, isRGB: boolean, value: number): number {
  if (isDefault) return -1;
  return isRGB ? RGB_FLAG | value : value;
}

function trimBlankTail(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(0, end);
}
