#!/bin/zsh
set -euo pipefail

APP_DIR="$HOME/Library/Application Support/TUPUpgradeBridge"
LOG_DIR="$HOME/Library/Logs/TUPUpgradeBridge"
PLIST="$HOME/Library/LaunchAgents/com.xhsmartpiano.tup-upgrade-bridge.plist"
LABEL="com.xhsmartpiano.tup-upgrade-bridge"

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"

if [[ "${KEEP_FILES:-0}" != "1" ]]; then
  rm -rf "$APP_DIR" "$LOG_DIR"
fi

echo "TUP升级助手已卸载"
