# sh

Run any shell command from Raycast, or work in a real interactive terminal without leaving it.

## sh
Type a command, press ↵, and watch the output stream in. ⌘R runs it again, ⌘. stops it, ⌘⇧T opens it in sh Terminal, ⌘⇧↵ opens it in your terminal app (Ghostty when installed; change it under Terminal App in the extension preferences).

## sh Terminal
A full terminal emulator drawn inside Raycast: colours, vim, less, htop, REPLs. Sessions keep running after you close Raycast.

| Input | |
| --- | --- |
| ↵ | send the search bar as a line (line mode) / Enter (live mode) |
| ⌘L | toggle live typing: every key goes straight to the terminal |
| ⌘↵ | type the search bar without Enter |
| ⌥ ↑ ↓ ← → | arrow keys · ⌥⇧ ↑ ↓ ← → Page Up/Down, Home/End |
| ⌃A – ⌃Z | control keys (⌃C interrupt, ⌃D EOF, ⌃R history, ⌃I Tab, ⌃L clear) |
| ⌃[ | Escape · ⇧⌫ Backspace |
| ⌘⇧V / ⌘⇧C | paste clipboard / copy screen |
| ⌘↑ ⌘↓ | scroll back · ⌘⇧↓ jump to bottom |
| ⌘= ⌘- ⌘0 | bigger / smaller / default text |
| ⌘N, ⌘⇧] ⌘⇧[, ⌘R, ⌘⇧W | new, next / previous, restart, close session |
| ⌘O / ⌘⇧O | scrollback in editor / open a link on screen |

F-keys, Shift-Tab and Delete are under **Special Keys** in the action panel.

Needs `/usr/bin/python3` (included with the Xcode Command Line Tools).
