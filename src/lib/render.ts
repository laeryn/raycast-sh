// Turn raw terminal bytes into plain text: strip escape sequences and apply
// carriage returns / backspaces the way a terminal would, so progress bars
// and spinners collapse to their final state instead of piling up.

// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OTHER_ESC = /\x1b[@-Z\\-_]|\x1b[()][0-9A-Za-z]/g;
// eslint-disable-next-line no-control-regex
const CLEAR_SCREEN = /\x1b\[[23]?J|\x1bc/g;

export function renderTerminal(raw: string): string {
  // Everything before the last clear-screen is gone, like in a real terminal.
  let lastClear = -1;
  for (const match of raw.matchAll(CLEAR_SCREEN)) lastClear = match.index + match[0].length;
  if (lastClear >= 0) raw = raw.slice(lastClear);

  const text = raw.replace(OSC, "").replace(CSI, "").replace(OTHER_ESC, "");
  const lines: string[] = [];
  let line: string[] = [];
  let col = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      lines.push(line.join(""));
      line = [];
      col = 0;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") continue; // CRLF is just a newline
      col = 0;
    } else if (ch === "\b") {
      col = Math.max(0, col - 1);
    } else if (ch === "\t") {
      const next = (Math.floor(col / 8) + 1) * 8;
      while (col < next) line[col++] ??= " ";
    } else if (ch < " " || ch === "\x7f") {
      // bell and other control characters: ignore
    } else {
      while (line.length < col) line.push(" ");
      line[col++] = ch;
    }
  }
  lines.push(line.join(""));
  return lines.map((l) => l.trimEnd()).join("\n");
}
