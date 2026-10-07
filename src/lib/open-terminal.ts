import { getApplications, getPreferenceValues, open } from "@raycast/api";
import { runAppleScript } from "@raycast/utils";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getShell, getWorkingDirectory } from "./shell";

const GHOSTTY = "com.mitchellh.ghostty";
const ITERM = "com.googlecode.iterm2";
const TERMINAL = "com.apple.Terminal";

const appleString = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const shellQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/** The app chosen in preferences, else Ghostty if installed, else Terminal. */
async function terminalApp(): Promise<{ name: string; bundleId?: string; path?: string }> {
  const { terminalApp } = getPreferenceValues<Preferences>();
  if (terminalApp?.bundleId || terminalApp?.path) return terminalApp;
  const apps = await getApplications();
  return apps.find((app) => app.bundleId === GHOSTTY) ?? { name: "Terminal", bundleId: TERMINAL };
}

/** Open `command` in a new window of the user's terminal app, typed into their shell so the window stays open after it finishes. */
export async function openInTerminalApp(command: string): Promise<string> {
  const app = await terminalApp();
  const cwd = getWorkingDirectory();

  switch (app.bundleId) {
    case GHOSTTY:
      await runAppleScript(`
        tell application "Ghostty"
          activate
          set cfg to new surface configuration
          set initial working directory of cfg to ${appleString(cwd)}
          set initial input of cfg to ${appleString(command + "\n")}
          new window with configuration cfg
        end tell`);
      break;
    case ITERM:
      await runAppleScript(`
        tell application "iTerm"
          activate
          set win to (create window with default profile)
          tell current session of win to write text ${appleString(`cd ${shellQuote(cwd)} && ${command}`)}
        end tell`);
      break;
    case TERMINAL:
      await runAppleScript(`
        tell application "Terminal"
          activate
          do script ${appleString(`cd ${shellQuote(cwd)} && ${command}`)}
        end tell`);
      break;
    default: {
      // Anything else: hand it a .command script and hope it runs scripts it's asked to open.
      const file = join(tmpdir(), `sh-${Date.now()}.command`);
      writeFileSync(file, `#!${getShell()} -l\ncd ${shellQuote(cwd)}\n${command}\nexec ${getShell()} -l\n`, {
        mode: 0o755,
      });
      await open(file, app.path ?? app.name);
    }
  }
  return app.name;
}
