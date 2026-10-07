#!/usr/bin/env bash
# Re-render the Glass / Fresh app icons from their HTML sources into assets/.
set -euo pipefail
cd "$(dirname "$0")"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot() { "$CH" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 --window-size=512,512 --screenshot="$PWD/$2" "file://$PWD/$1" >/dev/null 2>&1; }
shot icon-sh.html ../assets/icon.png
shot icon-terminal.html ../assets/terminal.png
cp icons/*.svg ../assets/icons/
echo "icons rendered"
