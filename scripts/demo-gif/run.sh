#!/bin/sh
# Records the README GIF: starts the Vite dev server, records the tour with
# record.cjs, stops the server and builds the GIF with make-gif.py.
#
#   scripts/demo-gif/run.sh [out.gif]     (default: docs/demo.gif)
set -e
cd "$(dirname "$0")/../.."

out=${1:-docs/demo.gif}
frames=$(mktemp -d -t lookout-gif)

if lsof -iTCP:1430 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 1430 is in use (pnpm tauri dev?). Stop it first." >&2
  exit 1
fi
pnpm exec vite --port 1430 --strictPort >/dev/null 2>&1 &
vite=$!
trap 'kill $vite 2>/dev/null; wait $vite 2>/dev/null; rm -rf "$frames"' EXIT
sleep 3

node scripts/demo-gif/record.cjs "$frames"
python3 -E scripts/demo-gif/make-gif.py "$frames" "$out"
ls -lh "$out"
