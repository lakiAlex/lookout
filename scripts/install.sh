#!/bin/sh
# Builds Lookout and installs it to /Applications.
#
# The app is signed ad hoc, and macOS ties an ad hoc app's Accessibility grant to
# the exact build. Signing with a requirement on the bundle id instead keeps the
# grant across rebuilds.
set -e
cd "$(dirname "$0")/.."

pnpm tauri build --bundles app
app=src-tauri/target/release/bundle/macos/Lookout.app
codesign --force --deep --sign - -r='designated => identifier "com.laki.lookout"' "$app"
codesign --verify --strict "$app"

osascript -e 'tell application id "com.laki.lookout" to quit' || true
while pgrep -x Lookout >/dev/null; do sleep 0.2; done
rm -rf /Applications/Lookout.app
ditto "$app" /Applications/Lookout.app
echo "Installed /Applications/Lookout.app"
