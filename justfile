# sh — Raycast extension. `just --list` shows every command.

# Install dependencies
install:
    npm install

# Load the extension into Raycast with hot reload (keep running while developing)
dev:
    npx ray develop

# Type-check and build into dist/
build:
    npx ray build -e dist

# Lint (ESLint + Prettier + manifest checks)
lint:
    npx ray lint

# Auto-fix lint and formatting issues
fix:
    npx ray lint --fix

# Smoke-test the pty broker outside Raycast: starts a shell, runs a command, prints the transcript
test-broker:
    #!/usr/bin/env bash
    set -euo pipefail
    d=$(mktemp -d); mkfifo "$d/in"; : > "$d/out"
    TERM=dumb python3 assets/pty-broker.py "$d" 100 30 "$HOME" /bin/sh -i >/dev/null 2>&1 &
    sleep 1; printf 'tty; echo broker-ok\n' > "$d/in"; sleep 0.5; printf 'exit 7\n' > "$d/in"; sleep 0.5
    cat "$d/out"; echo; echo "exit code: $(cat "$d/exit")"; rm -rf "$d"

# Kill the background terminal session, if one is running
kill-session:
    -pkill -f pty-broker.py

# Re-render the app icons (design/*.html, Glass / Fresh) and copy the line icons into assets/
icons:
    design/render.sh

# Drive real shells (ls, vim, top, less) through the emulator + SVG renderer; screens land in .smoke/ as SVG and PNG
smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p .smoke
    npx esbuild scripts/smoke-terminal.ts --bundle --platform=node --outfile=.smoke/smoke.js --log-level=warning
    node .smoke/smoke.js
    CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    for f in .smoke/*.svg; do
      h=$(grep -o 'height="[0-9]*"' "$f" | head -1 | tr -dc 0-9)
      "$CH" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 --window-size=640,"$h" --screenshot="$PWD/${f%.svg}.png" "file://$PWD/$f" >/dev/null 2>&1
    done
    ls .smoke/*.png
