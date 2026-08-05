#!/usr/bin/env bash
# Run an adb bridge on *this* machine, so the web app can share the device with
# Android Studio, `adb` in a terminal, and anything else that speaks adb.
#
# Why this exists: WebUSB claims the phone's USB interface exclusively. If an adb
# server already holds it — and Android Studio always starts one — the browser
# gets "device busy", and the only way out is `adb kill-server`, which kills
# Android Studio's connection instead. There is no sharing to be had at the USB
# layer.
#
# The adb server, on the other hand, is built to serve many clients at once. So
# this runs the same backend binary in relay-only mode next to it: the page opens
# a WebSocket here, this forwards the bytes to 127.0.0.1:5037, and the browser
# becomes just another adb client. Nothing gets killed.
#
#   ./scripts/bridge.sh
#
# Then in the web app: the gear button, top right → “用本机桥接”. The first
# connection makes Chrome ask for permission to reach the local network; allow it
# once (see NOTE below).
#
# Environment:
#   PORT=7070               where the bridge listens (loopback only)
#   ADB_SERVER=127.0.0.1:5037   the adb server to relay to
#
# NOTE on the permission prompt: Chrome's Local Network Access check blocks a page
# served from the internet from opening a connection to 127.0.0.1 unless you allow
# it. A real browser asks and remembers the answer; headless Chrome denies it
# silently, which is why this path cannot be covered by the automated tests.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-7070}"
ADB_SERVER="${ADB_SERVER:-127.0.0.1:5037}"
BIN=server/target/release/adbstudio-web-server

# The bridge is useless without the thing it bridges to. Starting it here rather
# than erroring out: `adb start-server` is exactly what the user would type next.
if ! adb start-server >/dev/null 2>&1; then
  echo "error: cannot start the adb server — is the Android SDK platform-tools on PATH?" >&2
  exit 1
fi
echo "adb server:"
adb devices | sed '1d;/^$/d;s/^/    /' || true
adb devices | sed '1d;/^$/d' | grep -q . || echo "    (no devices — plug one in, or this bridge will have nothing to share)"

if [ ! -x "$BIN" ]; then
  echo
  echo "==> Building the bridge (first run only)"
  cargo build --release --manifest-path server/Cargo.toml
fi

# Refuse rather than fight over the port: another copy of this bridge is already
# what someone usually has running, and silently failing to bind would look like
# the bridge is up when it is not.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo >&2
  echo "error: something is already listening on 127.0.0.1:${PORT}:" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed '1d;s/^/    /' >&2
  echo "Stop it, or run with a different port:  PORT=7071 $0" >&2
  exit 1
fi

echo
echo "==> Bridge on ws://127.0.0.1:${PORT}/api/adb  ->  adb server ${ADB_SERVER}"
echo "    In the web app:  right-hand gear button -> 用本机桥接"
echo "    Chrome will ask to access the local network the first time — allow it."
echo "    Ctrl-C to stop. Android Studio and 'adb' keep working throughout."
echo

# Loopback only, and no static files: this is a relay, not a deployment. Bound to
# 127.0.0.1 the backend runs without authentication, which is why it must never be
# given a routable address here.
exec env \
  ADBSTUDIO_ADDR="127.0.0.1:${PORT}" \
  ADBSTUDIO_ADB_SERVER="$ADB_SERVER" \
  "$BIN"
