import { Image } from "@raycast/api";

// Glass / Fresh line icons (assets/icons, 2px round strokes, drawn white and tinted here).
// The system is dark-only; the light values keep icons legible if Raycast runs in light mode.

export const tint = {
  primary: { light: "#2f3031", dark: "#e6e6e6", adjustContrast: true },
  secondary: { light: "#6a6b6c", dark: "#9c9c9d", adjustContrast: true },
  coral: { light: "#ff6363", dark: "#ff6363", adjustContrast: true },
  sky: { light: "#56c2ff", dark: "#56c2ff", adjustContrast: true },
  mint: { light: "#59d499", dark: "#59d499", adjustContrast: true },
  amber: { light: "#ffc533", dark: "#ffc533", adjustContrast: true },
} as const;

export type GlyphName =
  | "arrows"
  | "check"
  | "clear"
  | "clipboard"
  | "document"
  | "edit"
  | "eof"
  | "eraser"
  | "escape"
  | "external"
  | "history"
  | "interrupt"
  | "keyboard"
  | "link"
  | "live"
  | "pause"
  | "power"
  | "prompt"
  | "repeat"
  | "restart"
  | "return"
  | "run"
  | "scroll"
  | "session-new"
  | "stop"
  | "tab"
  | "terminal-window"
  | "trash"
  | "xmark"
  | "zoom-in"
  | "zoom-out";

export function glyph(name: GlyphName, color: keyof typeof tint = "primary"): Image.ImageLike {
  return { source: `icons/${name}.svg`, tintColor: tint[color] };
}
