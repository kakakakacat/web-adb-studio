#!/usr/bin/env bash
# Stage the two binary assets the web app serves from its own origin:
#
#   public/scrcpy-server    the scrcpy server jar, pushed to the device to mirror
#   public/icon-helper.apk  the DeepMirror icon helper, installed on demand to
#                           read fully-resolved launcher icons
#
# Unlike the native builds there are no sidecars to fetch: adb itself is gone,
# reimplemented in the browser by Tango. These two are the only leftovers.
#
# The scrcpy server version is PINNED: Tango's option definitions top out at
# 3.3.3, and a newer server rejects the option list and exits immediately. Bump
# SCRCPY_VERSION only together with @yume-chan/adb-scrcpy, and keep
# SCRCPY_SERVER_VERSION in src/adb/scrcpy.ts in sync.
set -euo pipefail
cd "$(dirname "$0")/.."

SCRCPY_VERSION="3.3.3"
DEST="public"
mkdir -p "$DEST"

# --- scrcpy server ---
if [ -f "$DEST/scrcpy-server" ]; then
  echo "scrcpy-server already staged; delete it to re-download."
else
  url="https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}"
  echo "Downloading scrcpy-server v${SCRCPY_VERSION}…"
  curl -fsSL "$url" -o "$DEST/scrcpy-server"
fi

# --- icon helper APK ---
# Committed in the native app's resources; copy it rather than rebuilding.
HELPER_SRC="../tauri-app/src-tauri/resources/icon-helper.apk"
if [ -f "$HELPER_SRC" ]; then
  cp "$HELPER_SRC" "$DEST/icon-helper.apk"
  echo "Copied icon-helper.apk from the native app resources."
else
  echo "WARN: $HELPER_SRC not found — app icons will fall back to the on-device"
  echo "      APK scan (works, but misses adaptive icons)."
fi

echo "Assets staged: $(ls "$DEST" | tr '\n' ' ')"
