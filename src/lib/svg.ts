// Render an emulator screen as an SVG "window" that Raycast can show as a markdown image.
// Text is grouped into same-style runs; each run is pinned to the cell grid with
// textLength so columns line up regardless of font metrics. No @raycast/api imports.

import { ATTR, Cell, RGB_FLAG, Screen } from "./emulator";

export const CANVAS_WIDTH = 640;
const PAD_X = 16;
const HEADER = 34;
const PAD_BOTTOM = 14;
const FONT = "SF Mono, Menlo, monospace";
const FG = "#e6e6e6";
const WINDOW_BG = "#0b0c0e"; // what "default background" looks like when inverted onto text

const ANSI = [
  "#2f3031",
  "#ff6363",
  "#59d499",
  "#ffc533",
  "#56c2ff",
  "#9b4dff",
  "#4fd1d9",
  "#cdcece",
  "#6a6b6c",
  "#ff8a8a",
  "#7ee2b1",
  "#ffd666",
  "#aae1ff",
  "#c69bff",
  "#8ae6ec",
  "#ffffff",
];

const PALETTE: string[] = (() => {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const colors = [...ANSI];
  const levels = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) colors.push(`#${hex(levels[r])}${hex(levels[g])}${hex(levels[b])}`);
  for (let i = 0; i < 24; i++) {
    const v = hex(8 + i * 10);
    colors.push(`#${v}${v}${v}`);
  }
  return colors;
})();

function resolve(color: number, fallback: string): string {
  if (color < 0) return fallback;
  if (color & RGB_FLAG) return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
  return PALETTE[color] ?? fallback;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, " "); // eslint-disable-line no-control-regex
}

type Style = { fg: string; bg: string | undefined; attrs: number };

function styleOf(cell: Cell): Style {
  let fgIndex = cell.fg;
  if (cell.attrs & ATTR.bold && fgIndex >= 0 && fgIndex < 8) fgIndex += 8; // bold-as-bright
  let fg = resolve(fgIndex, FG);
  let bg: string | undefined = cell.bg < 0 ? undefined : resolve(cell.bg, WINDOW_BG);
  if (cell.attrs & ATTR.inverse) {
    const swapped = bg ?? WINDOW_BG;
    bg = fg;
    fg = swapped;
  }
  return { fg, bg, attrs: cell.attrs };
}

/** Characters that the monospace font is expected to cover at exactly one cell, so they can share a run. */
function inRunnable(chars: string): boolean {
  if (chars.length !== 1) return false;
  const code = chars.charCodeAt(0);
  return code < 0x2000 || (code >= 0x2500 && code <= 0x259f);
}

export type RenderOptions = {
  title: string;
  live?: boolean;
  /** Extra status text drawn in the header (e.g. "exited 1"). */
  status?: string;
  width?: number;
};

export function renderSvg(screen: Screen, options: RenderOptions): string {
  const width = options.width ?? CANVAS_WIDTH;
  const cw = (width - PAD_X * 2) / screen.cols;
  const fontSize = cw / 0.6;
  const lh = Math.round(fontSize * 1.3 * 100) / 100;
  const height = Math.ceil(HEADER + lh * screen.rows + PAD_BOTTOM);
  const n = (v: number) => Math.round(v * 100) / 100;
  const baseline = lh * 0.5 + fontSize * 0.36;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><linearGradient id="g" x1="0.16" y1="0.13" x2="0.84" y2="0.87"><stop offset="0" stop-color="#151619"/><stop offset="1" stop-color="#07080a"/></linearGradient></defs>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="16" fill="url(#g)" stroke="#ffffff" stroke-opacity="0.06"/>`,
    `<line x1="16" y1="1" x2="${width - 16}" y2="1" stroke="#ffffff" stroke-opacity="0.1"/>`,
  );

  // Header: title left; LIVE pill, scroll indicator and size on the right.
  const headerY = 21;
  const sizeText = `${screen.cols}×${screen.rows}`;
  let right = width - PAD_X;
  const headerParts: string[] = [];
  headerParts.push(
    `<text x="${right}" y="${headerY}" text-anchor="end" fill="#6a6b6c" font-size="11">${escapeXml(sizeText)}</text>`,
  );
  right -= sizeText.length * 6.6 + 10;
  if (options.status) {
    headerParts.push(
      `<text x="${n(right)}" y="${headerY}" text-anchor="end" fill="#6a6b6c" font-size="11">${escapeXml(options.status)}</text>`,
    );
    right -= options.status.length * 6.6 + 10;
  }
  if (screen.scrolledBy > 0) {
    const text = `↑ ${screen.scrolledBy}`;
    headerParts.push(
      `<text x="${n(right)}" y="${headerY}" text-anchor="end" fill="#ffc533" font-size="11">${escapeXml(text)}</text>`,
    );
    right -= text.length * 6.6 + 10;
  }
  if (options.live) {
    const pillW = 38;
    const x = right - pillW;
    headerParts.push(
      `<rect x="${n(x)}" y="${headerY - 12}" width="${pillW}" height="16" rx="8" fill="#ff6363" fill-opacity="0.15" stroke="#ff6363" stroke-opacity="0.31"/>`,
      `<text x="${n(x + pillW / 2)}" y="${headerY - 0.5}" text-anchor="middle" fill="#ff6363" font-size="9.5" font-weight="600" letter-spacing="0.8">LIVE</text>`,
    );
    right = x - 10;
  }
  const maxTitle = Math.max(4, Math.floor((right - PAD_X) / 7.3));
  const title = options.title.length > maxTitle ? `${options.title.slice(0, maxTitle - 1)}…` : options.title;
  out.push(
    `<g font-family="${FONT}">`,
    `<text x="${PAD_X}" y="${headerY}" fill="#9c9c9d" font-size="12">${escapeXml(title)}</text>`,
    ...headerParts,
    `</g>`,
  );

  // Grid.
  const backgrounds: string[] = [];
  const texts: string[] = [];
  const decorations: string[] = [];

  for (let y = 0; y < screen.rows; y++) {
    const row = screen.cells[y];
    const top = HEADER + y * lh;
    const textY = n(top + baseline);

    // Background runs.
    let bgStart = 0;
    let bgColor: string | undefined;
    const flushBg = (end: number) => {
      if (bgColor && end > bgStart)
        backgrounds.push(
          `<rect x="${n(PAD_X + bgStart * cw)}" y="${n(top)}" width="${n((end - bgStart) * cw)}" height="${n(lh)}" fill="${bgColor}"/>`,
        );
    };
    // Text runs.
    let runStart = 0;
    let runText = "";
    let runStyle: Style | undefined;
    let runKey = "";
    const flushRun = (end: number) => {
      if (!runStyle || end <= runStart) return;
      const { fg, attrs } = runStyle;
      const x0 = PAD_X + runStart * cw;
      const cells = end - runStart;
      const lineAttrs = [
        attrs & ATTR.dim ? ` opacity="0.6"` : "",
        attrs & ATTR.bold ? ` font-weight="600"` : "",
        attrs & ATTR.italic ? ` font-style="italic"` : "",
      ].join("");
      if (attrs & ATTR.underline)
        decorations.push(
          `<rect x="${n(x0)}" y="${n(top + baseline + fontSize * 0.14)}" width="${n(cells * cw)}" height="1" fill="${fg}"${lineAttrs.includes("opacity") ? ` opacity="0.6"` : ""}/>`,
        );
      if (attrs & ATTR.strike)
        decorations.push(
          `<rect x="${n(x0)}" y="${n(top + baseline - fontSize * 0.3)}" width="${n(cells * cw)}" height="1" fill="${fg}"/>`,
        );
      if (attrs & ATTR.invisible) return;
      // Split on runs of 2+ spaces and place each segment at its exact column, so nothing depends on
      // the renderer preserving whitespace (single spaces between words never collapse).
      for (const segment of runText.matchAll(/\S+(?: \S+)*/g)) {
        texts.push(
          `<text x="${n(x0 + segment.index * cw)}" y="${textY}" textLength="${n(segment[0].length * cw)}" lengthAdjust="spacingAndGlyphs" fill="${fg}"${lineAttrs}>${escapeXml(segment[0])}</text>`,
        );
      }
    };

    for (let x = 0; x < screen.cols; x++) {
      const cell = row[x];
      if (cell.width === 0) continue; // right half of a wide character
      const style = styleOf(cell);
      const span = Math.max(1, cell.width);

      if (style.bg !== bgColor) {
        flushBg(x);
        bgStart = x;
        bgColor = style.bg;
      }

      const chars = cell.chars || " ";
      const key = `${style.fg}|${style.attrs & ~ATTR.inverse}`;
      if (span === 1 && inRunnable(chars)) {
        if (key !== runKey || !runStyle) {
          flushRun(x);
          runStart = x;
          runText = "";
          runStyle = style;
          runKey = key;
        }
        runText += chars;
      } else {
        // Wide or font-fallback-prone glyph: its own element, stretched to its cells.
        flushRun(x);
        runStyle = undefined;
        runKey = "";
        runText = "";
        if (!(style.attrs & ATTR.invisible) && chars.trim()) {
          const extra = [
            style.attrs & ATTR.dim ? ` opacity="0.6"` : "",
            style.attrs & ATTR.bold ? ` font-weight="600"` : "",
          ].join("");
          texts.push(
            `<text x="${n(PAD_X + x * cw)}" y="${textY}" textLength="${n(span * cw)}" lengthAdjust="spacingAndGlyphs" fill="${style.fg}"${extra}>${escapeXml(chars)}</text>`,
          );
        }
        if (style.attrs & ATTR.underline)
          decorations.push(
            `<rect x="${n(PAD_X + x * cw)}" y="${n(top + baseline + fontSize * 0.14)}" width="${n(span * cw)}" height="1" fill="${style.fg}"/>`,
          );
      }
    }
    flushRun(screen.cols);
    flushBg(screen.cols);
  }

  out.push(...backgrounds);

  const { cursor } = screen;
  if (cursor.visible && cursor.y >= 0 && cursor.y < screen.rows) {
    const cell = screen.cells[cursor.y]?.[cursor.x];
    const span = cell && cell.width === 2 ? 2 : 1;
    out.push(
      `<rect x="${n(PAD_X + cursor.x * cw)}" y="${n(HEADER + cursor.y * lh)}" width="${n(span * cw)}" height="${n(lh)}" rx="1.5" fill="#ff6363" fill-opacity="0.55"/>`,
    );
  }

  out.push(`<g font-family="${FONT}" font-size="${n(fontSize)}">`, ...texts, `</g>`, ...decorations, `</svg>`);
  return out.join("");
}

export function svgToMarkdown(svg: string, alt = "terminal"): string {
  return `![${alt}](data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")})`;
}
