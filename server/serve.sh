#!/usr/bin/env bash
# Runs the backend for tunnel exposure: bound to loopback, with the access token
# from server/.token, serving the built frontend.
#
# Binding to 127.0.0.1 is deliberate — cloudflared connects to it locally, so the
# port is never open on the LAN. The token is defence in depth behind Cloudflare
# Access (see DEPLOY-REMOTE.md).
#
#   ./serve.sh              # release build, port 7070
#   PORT=8080 ./serve.sh
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-7070}"
DIST="../web/dist"

if [ ! -f .token ]; then
  echo "error: .token missing. Generate one:" >&2
  echo "  umask 077 && openssl rand -hex 32 > server/.token" >&2
  exit 1
fi

if [ ! -f "$DIST/index.html" ]; then
  echo "error: $DIST not built. Run:  (cd ../web && npm run assets && npm run build)" >&2
  exit 1
fi

# The bridge needs a real adb server; it owns the USB interface and multiplexes,
# so this also lets the terminal and Android Studio share the device.
if command -v adb >/dev/null 2>&1; then
  adb start-server >/dev/null 2>&1 || echo "warning: adb start-server failed" >&2
fi

cargo build --release --quiet

export ADBSTUDIO_ADDR="127.0.0.1:${PORT}"
export ADBSTUDIO_STATIC="$DIST"
export ADBSTUDIO_TOKEN="$(cat .token)"

echo "serving on http://127.0.0.1:${PORT} (token required for /api/*)"
exec target/release/adbstudio-web-server
