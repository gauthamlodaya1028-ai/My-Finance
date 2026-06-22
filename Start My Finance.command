#!/bin/bash
cd "$(dirname "$0")"
# Load nvm so node/npm are on PATH when double-clicked (Finder uses a bare shell)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
command -v node >/dev/null 2>&1 || export PATH="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1):$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install it, then run again."; read -r _; exit 1
fi
[ -d node_modules ] || npm install
( sleep 2 && open http://localhost:3000 ) &
echo "Starting My Finance at http://localhost:3000  (close this window or Ctrl-C to stop)"
npm start
