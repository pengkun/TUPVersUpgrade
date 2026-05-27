#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="$ROOT_DIR/dist/macos/TUP升级助手.app"
DMG_DIR="$ROOT_DIR/dist/macos/dmg-root"
DMG_PATH="$ROOT_DIR/dist/macos/TUP升级助手-mac.dmg"

if [[ ! -d "$APP_PATH" ]]; then
  "$ROOT_DIR/scripts/build-macos-bridge.sh"
fi

rm -rf "$DMG_DIR" "$DMG_PATH"
mkdir -p "$DMG_DIR"
cp -R "$APP_PATH" "$DMG_DIR/TUP升级助手.app"
ln -s /Applications "$DMG_DIR/Applications"

hdiutil create \
  -volname "TUP升级助手" \
  -srcfolder "$DMG_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

echo "Built dmg: $DMG_PATH"
