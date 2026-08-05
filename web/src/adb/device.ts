// Device identity, power and wireless-debugging actions.

import type { Adb } from "@yume-chan/adb";

import type { DeviceInfo, RebootMode } from "../types";
import { getProps, shell } from "./shell";

export async function deviceInfo(adb: Adb): Promise<DeviceInfo> {
  const p = await getProps(adb);
  // `ro.boot.flash.locked=0` or a non-green verified-boot state means the
  // bootloader has been unlocked. Absent on many devices -> leave undefined.
  const locked = p.get("ro.boot.flash.locked");
  const vbState = p.get("ro.boot.verifiedbootstate");
  let bootloaderUnlocked: boolean | undefined;
  if (locked !== undefined) bootloaderUnlocked = locked === "0";
  else if (vbState !== undefined) bootloaderUnlocked = vbState !== "green";

  return {
    serial: adb.serial,
    model: p.get("ro.product.model"),
    brand: p.get("ro.product.brand"),
    androidVersion: p.get("ro.build.version.release"),
    sdkVersion: p.get("ro.build.version.sdk"),
    product: p.get("ro.product.name"),
    abi: p.get("ro.product.cpu.abi"),
    bootloaderUnlocked,
  };
}

export async function reboot(adb: Adb, mode: RebootMode): Promise<void> {
  switch (mode) {
    case "system":
      await adb.power.reboot();
      break;
    case "recovery":
      await adb.power.recovery();
      break;
    case "bootloader":
      await adb.power.bootloader();
      break;
    case "fastboot":
      await adb.power.fastboot();
      break;
  }
}

/**
 * Restart adbd as root. Only works on userdebug/eng builds; on production
 * builds the daemon replies "adbd cannot run as root in production builds".
 *
 * Unlike the native app we can't call the host-server's `root:` service, so we
 * talk to the daemon service directly.
 */
/**
 * True when an error means "the transport we were holding no longer exists".
 *
 * The adb server keys connections by transport id and a restarted adbd comes
 * back under a new one, so every later call on the old object fails this way —
 * most visibly right after root/remount, but equally after a replug or an
 * `adb kill-server`. Recognising it is what lets the app reconnect instead of
 * showing the user an id number they can do nothing with.
 */
export function isStaleTransport(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return (
    /no device with transport id/i.test(message) ||
    /device (?:offline|not found)/i.test(message) ||
    /transport (?:id )?(?:not found|closed)/i.test(message) ||
    /closed|disconnected/i.test(message)
  );
}

/**
 * `root:`/`unroot:` restart adbd, so the connection this was issued on dies as
 * part of succeeding. Callers must acquire a new transport afterwards — the
 * store's `restartAdbd` does that; don't call these directly from the UI.
 */
export async function root(adb: Adb): Promise<string> {
  return adb.createSocketAndWait("root:");
}

export async function unroot(adb: Adb): Promise<string> {
  return adb.createSocketAndWait("unroot:");
}

/**
 * `remount:` does not restart adbd, but it is almost always issued straight
 * after `root:` and inherits whatever state that left behind.
 */
export async function remount(adb: Adb): Promise<string> {
  return adb.createSocketAndWait("remount:");
}

/** `ro.build.type` — used to grey out root/remount on production builds. */
export async function buildType(adb: Adb): Promise<string> {
  return (await shell(adb, "getprop ro.build.type")).trim();
}

/** uid adbd is running as; "0" means it is already root. */
export async function currentUid(adb: Adb): Promise<string> {
  const out = await shell(adb, "id -u");
  return out.trim();
}
