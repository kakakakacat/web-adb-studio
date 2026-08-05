#!/bin/sh
# Bring up the adb server, then the web backend in the foreground so the
# container's lifetime tracks the app.
set -e

# A dead adb server just means wireless devices are unavailable; the app still
# serves USB (WebUSB, in the browser), SFTP and Dino admin. So don't fail hard.
if command -v adb >/dev/null 2>&1; then
  adb start-server || echo "warning: adb start-server failed; wireless devices unavailable" >&2
fi

exec adbstudio-web-server "$@"
