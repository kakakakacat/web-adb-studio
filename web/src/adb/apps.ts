// Package management. Straight port of the Rust `commands.rs` + `parser.rs`
// package logic, with `adb shell` replaced by Tango's subprocess service.

import type { Adb } from "@yume-chan/adb";

import type { AppListFilter, InstalledApp } from "../types";
import { SYSTEM_APP_PREFIX } from "./install-target";
import { extractImage, sh, shell, shellBytes } from "./shell";
import { pushBytes } from "./files";

const LIST_FLAGS: Record<AppListFilter, string> = {
  all: "",
  thirdParty: "-3",
  system: "-s",
  disabled: "-d",
  // No flag: `pm list packages <text>` filters by substring, and the exact
  // prefix is enforced below. Letting the device narrow it first keeps the
  // output small on a phone with 200+ packages.
  dm: sh(SYSTEM_APP_PREFIX),
};

export async function appList(
  adb: Adb,
  filter: AppListFilter
): Promise<string[]> {
  const out = await shell(adb, `pm list packages ${LIST_FLAGS[filter]}`);
  const packages = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("package:"))
    .map((l) => l.slice("package:".length))
    .filter(Boolean)
    .sort();
  // `pm`'s text filter matches anywhere in the name, so "com.dm.ai" would also
  // return something like "org.example.com.dm.ai.clone". Narrow it to a real
  // prefix here.
  return filter === "dm"
    ? packages.filter((p) => p.startsWith(`${SYSTEM_APP_PREFIX}.`) || p === SYSTEM_APP_PREFIX)
    : packages;
}

/** Port of `parser::parse_package_info`. */
export function parsePackageInfo(output: string, packageName: string): InstalledApp {
  let versionName: string | undefined;
  let versionCode: number | undefined;
  let installTime: string | undefined;
  let updateTime: string | undefined;
  let isSystemApp = false;
  let isEnabled = true;

  for (const line of output.split("\n")) {
    const t = line.trim();
    if (t.startsWith("versionName=")) {
      versionName = t.slice("versionName=".length).slice(0, 100);
    } else if (t.startsWith("versionCode=")) {
      // e.g. "123 minSdk=21" -> take the leading integer.
      const n = Number.parseInt(t.slice("versionCode=".length).split(/\s+/)[0], 10);
      if (Number.isFinite(n)) versionCode = n;
    } else if (t.startsWith("firstInstallTime=")) {
      installTime = t.slice("firstInstallTime=".length);
    } else if (t.startsWith("lastUpdateTime=")) {
      updateTime = t.slice("lastUpdateTime=".length);
    } else if (t.includes("pkgFlags=") && t.includes("SYSTEM")) {
      isSystemApp = true;
    } else if (t.startsWith("enabled=")) {
      const state = t.slice("enabled=".length).trim();
      if (state === "0" || state.toLowerCase() === "false") isEnabled = false;
    }
  }

  if (output.includes("packageFlags=[ HIDDEN ]") || output.includes("DISABLED")) {
    isEnabled = false;
  }
  if (output.includes("enabledState=COMPONENT_ENABLED_STATE_DISABLED")) {
    isEnabled = false;
  }

  return {
    packageName,
    versionName,
    versionCode,
    installTime,
    updateTime,
    isSystemApp,
    isEnabled,
  };
}

export async function appInfo(adb: Adb, pkg: string): Promise<InstalledApp> {
  const out = await shell(adb, `dumpsys package ${sh(pkg)}`);
  return parsePackageInfo(out, pkg);
}

export async function appLaunch(adb: Adb, pkg: string): Promise<void> {
  await shell(adb, `monkey -p ${sh(pkg)} -c android.intent.category.LAUNCHER 1`);
}

export async function appForceStop(adb: Adb, pkg: string): Promise<void> {
  await shell(adb, `am force-stop ${sh(pkg)}`);
}

export async function appClearData(adb: Adb, pkg: string): Promise<void> {
  await shell(adb, `pm clear ${sh(pkg)}`);
}

export async function appUninstall(
  adb: Adb,
  pkg: string,
  keepData: boolean
): Promise<void> {
  const out = await shell(adb, `pm uninstall ${keepData ? "-k " : ""}${sh(pkg)}`);
  if (!out.includes("Success")) throw new Error(out.trim() || "卸载失败");
}

export async function appSetEnabled(
  adb: Adb,
  pkg: string,
  enabled: boolean
): Promise<void> {
  const verb = enabled ? "enable" : "disable-user";
  const out = await shell(adb, `pm ${verb} ${sh(pkg)}`);
  if (out.toLowerCase().includes("error")) throw new Error(out.trim());
}

// --- launcher icons -------------------------------------------------------

const ICON_HELPER_AUTHORITY = "com.deepmirror.iconhelper.icons";
const ICON_HELPER_PACKAGE = "com.deepmirror.iconhelper";
/** Served from web/public/ — the same APK the native app bundled as a resource. */
const ICON_HELPER_URL = "/icon-helper.apk";

/**
 * On-device fallback when the helper isn't usable: resolve the APK, pick the
 * best launcher icon, stream its bytes. Copied verbatim from `commands.rs` so
 * behaviour matches the native app.
 */
const ICON_FALLBACK_SCRIPT = `p=$(pm path %PKG% 2>/dev/null|sed -n "s/package://p"); a=$(echo "$p"|grep -m1 base.apk); [ -z "$a" ] && a=$(echo "$p"|head -1); [ -z "$a" ] && exit 1; l=$(unzip -l "$a" 2>/dev/null); e=""; for d in xxxhdpi xxhdpi xhdpi hdpi mdpi; do e=$(echo "$l"|grep -oE "res/[^ ]*$d[^ ]*/ic_launcher\\.(webp|png)"|head -1); [ -n "$e" ] && break; done; [ -z "$e" ] && e=$(echo "$l"|grep -oE "res/[^ ]*ic_launcher[^ ]*\\.(webp|png)"|head -1); [ -n "$e" ] && unzip -p "$a" "$e"`;

const VALID_PACKAGE = /^[A-Za-z0-9._]+$/;

/**
 * In-flight (or settled) helper install per device serial.
 *
 * Must be a shared promise rather than an "already tried" flag: icons load
 * several at a time, so on a device without the helper the first request starts
 * the install (push 645 KB + `pm install`, several seconds) while its siblings
 * would see the flag, give up, and cache a null icon that never retries. Sharing
 * the promise makes them all wait for the same install and then succeed.
 */
const helperInstall = new Map<string, Promise<boolean>>();

function isPng(b: Uint8Array): boolean {
  return (
    b.length > 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  );
}

function isWebp(b: Uint8Array): boolean {
  return (
    b.length > 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  );
}

function toDataUrl(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:image/${isWebp(bytes) ? "webp" : "png"};base64,${btoa(binary)}`;
}

/**
 * Read one icon from the helper's ContentProvider.
 *
 * Two command shapes are tried: some Android builds require `--user` on `content`
 * (multi-user devices in particular), and the plain form then fails with a
 * provider-not-found message rather than returning bytes.
 */
async function readHelperIcon(adb: Adb, pkg: string): Promise<Uint8Array | undefined> {
  const uri = `content://${ICON_HELPER_AUTHORITY}/${pkg}`;
  for (const cmd of [
    `content read --uri ${sh(uri)}`,
    `content read --user 0 --uri ${sh(uri)}`,
  ]) {
    try {
      // extractImage skips any preamble the device's shell printed first.
      const image = extractImage(await shellBytes(adb, cmd));
      if (image) return image;
    } catch {
      /* try the next shape */
    }
  }
  return undefined;
}

/** First line of a command's output, for diagnostics. */
function summarize(bytes: Uint8Array): string {
  const image = extractImage(bytes);
  if (image) {
    const skipped = bytes.length - image.length;
    return (
      `OK — ${isPng(image) ? "PNG" : "WebP"}, ${image.length} 字节` +
      (skipped > 0 ? `（跳过前面 ${skipped} 字节的 shell 噪声）` : "")
    );
  }
  if (bytes.length === 0) return "空输出";
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 160))
    .replace(/\s+/g, " ")
    .trim();
  return `非图片（${bytes.length} 字节）：${text}`;
}

/**
 * Walk the icon lookup step by step and report what each one did.
 *
 * Exists because a failed icon is otherwise invisible: `appIcon` swallows every
 * error and returns null, which renders identically to "this app has no icon".
 * On an unfamiliar OS version that leaves nothing to go on.
 */
export async function diagnoseIcon(adb: Adb, pkg: string): Promise<string[]> {
  const out: string[] = [];
  const add = (s: string) => out.push(s);

  try {
    add(`设备：Android ${(await shell(adb, "getprop ro.build.version.release")).trim()} / SDK ${(await shell(adb, "getprop ro.build.version.sdk")).trim()}`);
  } catch {
    add("设备：无法读取 ro.build.version.*");
  }
  add(`目标包：${pkg}`);

  const installed = await shell(adb, `pm path ${ICON_HELPER_PACKAGE}`).catch((e) => `错误 ${e}`);
  add(`1) helper 已安装：${installed.includes("package:") ? "是" : `否 — ${installed.trim() || "(无输出)"}`}`);

  if (!installed.includes("package:")) {
    // Reproduce the auto-install so its failure is visible too.
    try {
      const res = await fetch(ICON_HELPER_URL);
      add(`2) 下载 ${ICON_HELPER_URL}：HTTP ${res.status}`);
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const remote = "/data/local/tmp/adbstudio-icon-helper.apk";
        await pushBytes(adb, bytes, remote);
        const install = await shell(adb, `pm install -r ${remote}`);
        add(`3) pm install：${install.trim() || "(无输出)"}`);
        await shell(adb, `rm -f ${remote}`);
      }
    } catch (e) {
      add(`2) 安装失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const uri = `content://${ICON_HELPER_AUTHORITY}/${pkg}`;
  for (const [label, cmd] of [
    ["content read", `content read --uri ${sh(uri)}`],
    ["content read --user 0", `content read --user 0 --uri ${sh(uri)}`],
  ] as const) {
    try {
      add(`4) ${label}：${summarize(await shellBytes(adb, cmd))}`);
    } catch (e) {
      add(`4) ${label}：抛错 ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    const fb = await shellBytes(adb, ICON_FALLBACK_SCRIPT.replace("%PKG%", pkg));
    add(`5) APK 扫描回退：${summarize(fb)}`);
  } catch (e) {
    add(`5) APK 扫描回退：抛错 ${e instanceof Error ? e.message : String(e)}`);
  }

  return out;
}

/** Install the bundled icon helper once per device. Returns true if present. */
function ensureIconHelper(adb: Adb): Promise<boolean> {
  const pending = helperInstall.get(adb.serial);
  if (pending) return pending;
  const attempt = installIconHelper(adb);
  helperInstall.set(adb.serial, attempt);
  return attempt;
}

async function installIconHelper(adb: Adb): Promise<boolean> {
  try {
    const installed = await shell(adb, `pm path ${ICON_HELPER_PACKAGE}`);
    if (installed.includes("package:")) return true;

    const res = await fetch(ICON_HELPER_URL);
    if (!res.ok) return false;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const remote = "/data/local/tmp/adbstudio-icon-helper.apk";
    await pushBytes(adb, bytes, remote);
    const out = await shell(adb, `pm install -r ${remote}`);
    await shell(adb, `rm -f ${remote}`);
    return out.includes("Success");
  } catch {
    return false;
  }
}

/** Fully-resolved launcher icon as a data URL, or null. */
export async function appIcon(adb: Adb, pkg: string): Promise<string | null> {
  if (!VALID_PACKAGE.test(pkg)) return null;

  let bytes = await readHelperIcon(adb, pkg);
  if (!bytes && (await ensureIconHelper(adb))) {
    bytes = await readHelperIcon(adb, pkg);
  }
  if (!bytes) {
    // Last resort: scan the APK for a bitmap launcher icon. Often finds nothing
    // on modern apps, whose icons are adaptive (XML + arbitrarily named layers) —
    // which is exactly why the helper exists.
    try {
      const out = extractImage(await shellBytes(adb, ICON_FALLBACK_SCRIPT.replace("%PKG%", pkg)));
      if (out) bytes = out;
    } catch {
      /* no icon */
    }
  }
  return bytes ? toDataUrl(bytes) : null;
}
