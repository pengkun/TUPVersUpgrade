#!/bin/zsh
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$HOME/Library/Application Support/TUPUpgradeBridge"
LOG_DIR="$HOME/Library/Logs/TUPUpgradeBridge"
PLIST="$HOME/Library/LaunchAgents/com.xhsmartpiano.tup-upgrade-bridge.plist"
LABEL="com.xhsmartpiano.tup-upgrade-bridge"

mkdir -p "$APP_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
cp "$SOURCE_DIR/server.js" "$APP_DIR/server.js"
cp "$SOURCE_DIR/native_usb_probe.c" "$APP_DIR/native_usb_probe.c"
cp "$SOURCE_DIR/native_midi_bridge.swift" "$APP_DIR/native_midi_bridge.swift"
cp "$SOURCE_DIR/macos/bridge_server.swift" "$APP_DIR/bridge_server.swift" 2>/dev/null || true
cp "$SOURCE_DIR/.gitignore" "$APP_DIR/.gitignore" 2>/dev/null || true
mkdir -p "$APP_DIR/.build"
if [[ -x "$SOURCE_DIR/.build/native_usb_probe" ]]; then
  cp "$SOURCE_DIR/.build/native_usb_probe" "$APP_DIR/.build/native_usb_probe"
fi
if [[ -x "$SOURCE_DIR/.build/bridge_server" ]]; then
  cp "$SOURCE_DIR/.build/bridge_server" "$APP_DIR/bridge_server"
else
  mkdir -p "$APP_DIR/.build/module-cache"
  CLANG_MODULE_CACHE_PATH="$APP_DIR/.build/module-cache" swiftc "$SOURCE_DIR/macos/bridge_server.swift" -o "$APP_DIR/bridge_server"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_DIR/bridge_server</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key>
    <string>127.0.0.1</string>
    <key>PORT</key>
    <string>18080</string>
    <key>BRIDGE_ALLOWED_ORIGINS</key>
    <string>${BRIDGE_ALLOWED_ORIGINS:-http://127.0.0.1:8080,http://127.0.0.1:18080,http://localhost:8080,http://localhost:18080,https://upgrade.xhsmartpiano.com}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/stderr.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "TUP升级助手已安装并启动: http://127.0.0.1:18080/api/bridge/status"
