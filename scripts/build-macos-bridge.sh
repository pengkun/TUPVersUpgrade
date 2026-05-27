#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist/macos/TUPUpgradeBridge"
APP_DIR="$ROOT_DIR/dist/macos/TUP升级助手.app"

rm -rf "$OUT_DIR" "$APP_DIR"
mkdir -p "$OUT_DIR/macos" "$OUT_DIR/.build"

cp "$ROOT_DIR/server.js" "$OUT_DIR/server.js"
cp "$ROOT_DIR/native_usb_probe.c" "$OUT_DIR/native_usb_probe.c"
cp "$ROOT_DIR/native_midi_bridge.swift" "$OUT_DIR/native_midi_bridge.swift"
cp "$ROOT_DIR/macos/bridge_server.swift" "$OUT_DIR/macos/bridge_server.swift"
cp "$ROOT_DIR/macos/start-bridge.command" "$OUT_DIR/macos/start-bridge.command"
cp "$ROOT_DIR/macos/install-launch-agent.sh" "$OUT_DIR/macos/install-launch-agent.sh"
cp "$ROOT_DIR/macos/uninstall-launch-agent.sh" "$OUT_DIR/macos/uninstall-launch-agent.sh"

chmod +x "$OUT_DIR/macos/"*.sh "$OUT_DIR/macos/start-bridge.command"

cc "$ROOT_DIR/native_usb_probe.c" \
  -o "$OUT_DIR/.build/native_usb_probe" \
  -framework IOKit \
  -framework CoreFoundation

mkdir -p "$OUT_DIR/.build/module-cache"
CLANG_MODULE_CACHE_PATH="$OUT_DIR/.build/module-cache" \
  swiftc "$ROOT_DIR/macos/bridge_server.swift" -o "$OUT_DIR/.build/bridge_server"

if command -v swiftc >/dev/null 2>&1; then
  mkdir -p "$OUT_DIR/.build/module-cache"
  CLANG_MODULE_CACHE_PATH="$OUT_DIR/.build/module-cache" \
    swiftc "$ROOT_DIR/native_midi_bridge.swift" -o "$OUT_DIR/.build/native_midi_bridge"
fi

cat > "$OUT_DIR/README.md" <<'EOF'
# TUP Upgrade Bridge for macOS

这是 Mac 本地升级助手的开发包。它在用户电脑本机启动 `127.0.0.1:18080`，供云端升级网页调用。

## 启动

双击：

```text
macos/start-bridge.command
```

或安装为后台服务：

```sh
macos/install-launch-agent.sh
```

## 验证

```sh
curl http://127.0.0.1:18080/api/bridge/status
curl http://127.0.0.1:18080/api/device/probe
```

## 卸载

```sh
macos/uninstall-launch-agent.sh
```
EOF

mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources/bridge"
cp "$ROOT_DIR/macos/TUPUpgradeBridge.app.template/Contents/Info.plist" "$APP_DIR/Contents/Info.plist"
cp "$ROOT_DIR/macos/TUPUpgradeBridge.app.template/Contents/MacOS/TUPUpgradeBridge" "$APP_DIR/Contents/MacOS/TUPUpgradeBridge"
chmod +x "$APP_DIR/Contents/MacOS/TUPUpgradeBridge"
cp "$OUT_DIR/server.js" "$APP_DIR/Contents/Resources/bridge/server.js"
cp "$OUT_DIR/.build/bridge_server" "$APP_DIR/Contents/Resources/bridge/bridge_server"
cp "$OUT_DIR/native_usb_probe.c" "$APP_DIR/Contents/Resources/bridge/native_usb_probe.c"
cp "$OUT_DIR/native_midi_bridge.swift" "$APP_DIR/Contents/Resources/bridge/native_midi_bridge.swift"
mkdir -p "$APP_DIR/Contents/Resources/bridge/.build"
cp "$OUT_DIR/.build/native_usb_probe" "$APP_DIR/Contents/Resources/bridge/.build/native_usb_probe"
if [[ -f "$OUT_DIR/.build/native_midi_bridge" ]]; then
  cp "$OUT_DIR/.build/native_midi_bridge" "$APP_DIR/Contents/Resources/bridge/.build/native_midi_bridge"
fi
echo "Built: $OUT_DIR"
echo "Built app: $APP_DIR"
