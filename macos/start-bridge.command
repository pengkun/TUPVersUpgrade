#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_SERVER="$ROOT_DIR/.build/bridge_server"

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-18080}"
export BRIDGE_ALLOWED_ORIGINS="${BRIDGE_ALLOWED_ORIGINS:-http://127.0.0.1:8080,http://127.0.0.1:18080,http://localhost:8080,http://localhost:18080,https://upgrade.xhsmartpiano.com}"

cd "$ROOT_DIR"
if [[ ! -x "$BRIDGE_SERVER" ]]; then
  mkdir -p "$ROOT_DIR/.build/module-cache"
  CLANG_MODULE_CACHE_PATH="$ROOT_DIR/.build/module-cache" swiftc "$ROOT_DIR/macos/bridge_server.swift" -o "$BRIDGE_SERVER"
fi
exec "$BRIDGE_SERVER"
