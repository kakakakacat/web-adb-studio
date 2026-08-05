#!/usr/bin/env bash
# Stage the two binary assets the web app serves from its own origin:
#
#   public/scrcpy-server    the scrcpy server jar, pushed to the device to mirror
#   public/icon-helper.apk  the icon helper (../icon-helper), installed on demand
#                           to read fully-resolved launcher icons
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
# 从源码构建（../icon-helper）。原来是从原生应用的 resources 里复制一份预编译产物，
# 那个目录已经不存在了；从源码出的好处是包名/权限这类改动不会和产物脱节。
#
# 需要 Android SDK（icon-helper/local.properties 里的 sdk.dir，或者 ANDROID_HOME）。
# 没有也能用：图标会退回到设备上直接扫 APK 的路径 —— 能work，但拿不到自适应图标。
HELPER_APK="../icon-helper/build/outputs/apk/release/icon-helper-release.apk"
if [ -f "$DEST/icon-helper.apk" ]; then
  echo "icon-helper.apk already staged; delete it to rebuild."
elif (cd ../icon-helper && ./gradlew --quiet assembleRelease) 2>/dev/null && [ -f "$HELPER_APK" ]; then
  cp "$HELPER_APK" "$DEST/icon-helper.apk"
  echo "Built icon-helper.apk from source."
else
  echo "WARN: 构建 icon-helper 失败（缺 Android SDK？）—— 应用图标会退回到设备端"
  echo "      扫 APK 的方式，功能可用但拿不到自适应图标。"
fi

echo "Assets staged: $(ls "$DEST" | tr '\n' ' ')"
