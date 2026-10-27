#!/usr/bin/env bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js from https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install
(sleep 2; open http://localhost:5173 2>/dev/null || xdg-open http://localhost:5173 2>/dev/null) &
npm run dev
