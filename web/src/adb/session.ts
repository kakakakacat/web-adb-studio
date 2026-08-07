// Device connection lifecycle. Replaces the adb *host server* entirely: the
// browser speaks the ADB daemon protocol straight down a WebUSB pipe, so there
// is no `adb` binary, no server to start, and nothing to bundle.
//
// Two consequences the UI has to surface (see ../ui/UsbHelp.tsx):
//   1. A local `adb` server steals the USB interface — the user must run
//      `adb kill-server` first, or `connect()` throws DeviceBusyError.
//   2. WebUSB only hands us devices the user explicitly picked in the browser's
//      chooser, so "refresh" can only ever list previously-granted devices.
//      Finding a *new* device always requires a user gesture -> requestDevice().

import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import {
  AdbDaemonWebUsbDevice,
  AdbDaemonWebUsbDeviceManager,
} from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";

import * as diag from "../diag";
import type { Device } from "../types";

/** The RSA keypair that authorizes us on devices; persisted in IndexedDB, so
 *  the "Allow USB debugging?" prompt only appears once per device. */
const credentialStore = new AdbWebCredentialStore("ADB Studio Web");

export const manager = AdbDaemonWebUsbDeviceManager.BROWSER;

export function webUsbSupported(): boolean {
  return manager !== undefined;
}

/** WebUSB requires a secure context; on plain http:// the API is absent. */
export function secureContextOk(): boolean {
  return window.isSecureContext;
}

/** A live, authenticated connection plus the metadata the UI shows. */
export interface Session {
  adb: Adb;
  device: Device;
  /** Resolves when the device goes away (unplugged, adb server stole it, …). */
  disconnected: Promise<void>;
  close(): Promise<void>;
}

function toDevice(raw: AdbDaemonWebUsbDevice, state: Device["state"]): Device {
  return {
    id: `webusb:${raw.serial}`,
    serial: raw.serial,
    name: raw.name,
    state,
    connection: "usb",
    source: "webusb",
  };
}

/** Devices the user has already granted this origin access to. */
export async function listGrantedDevices(): Promise<Device[]> {
  if (!manager) return [];
  const raws = await manager.getDevices();
  return raws.map((r) => toDevice(r, "offline"));
}

/** Prompt the browser's device chooser. Returns undefined if the user cancels. */
export async function requestDevice(): Promise<AdbDaemonWebUsbDevice | undefined> {
  if (!manager) throw new Error("此浏览器不支持 WebUSB，请使用 Chrome / Edge。");
  return manager.requestDevice();
}

export async function findGrantedDevice(
  serial: string
): Promise<AdbDaemonWebUsbDevice | undefined> {
  if (!manager) return undefined;
  const raws = await manager.getDevices();
  return raws.find((r) => r.serial === serial);
}

/**
 * An adb server already holds the device's USB interface.
 *
 * Worth its own type because it is the one connection failure with an automatic
 * remedy: the same device is reachable through a bridge to that very adb server.
 */
export class DeviceBusyError extends Error {}

/**
 * Open + authenticate a device. The first call for a given device shows the
 * on-device "Allow USB debugging" dialog; `authenticate` stays pending until
 * the user accepts, so callers should show a waiting state.
 */
export async function connect(raw: AdbDaemonWebUsbDevice): Promise<Session> {
  let connection;
  diag.log("usb", "claiming interface", { serial: raw.serial, name: raw.name });
  try {
    connection = await raw.connect();
  } catch (e) {
    diag.log("usb", "claim failed", {
      serial: raw.serial,
      // The distinction that decides everything downstream: "busy" has an
      // automatic remedy (the bridge), anything else does not.
      busy: e instanceof AdbDaemonWebUsbDevice.DeviceBusyError,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
    if (e instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
      // Two ways out, and the order matters: `kill-server` disconnects Android
      // Studio, the bridge doesn't. Recommend the one that doesn't break the
      // user's other tools. A distinct type so the store can act on it — this is
      // the one failure that has an automatic remedy.
      throw new DeviceBusyError(
        "设备被 adb 占用（Android Studio 或终端的 adb 都会占用它）。" +
          "推荐改用本机桥接，可以和它们同时使用同一台设备 —— 点右上角齿轮 → “用本机桥接”。" +
          "也可以运行 `adb kill-server` 让浏览器独占，但那会断开 Android Studio。"
      );
    }
    throw e;
  }

  const transport = await AdbDaemonTransport.authenticate({
    serial: raw.serial,
    connection,
    credentialStore,
  });

  const adb = new Adb(transport);
  const device = toDevice(raw, "device");
  diag.log("usb", "authenticated", { serial: raw.serial, model: transport.banner.model });
  device.product = transport.banner.product;
  device.model = transport.banner.model;

  return {
    adb,
    device,
    disconnected: transport.disconnected,
    close: () => adb.close(),
  };
}

/** Convenience: pick a device via the chooser and connect to it. */
export async function pickAndConnect(): Promise<Session | undefined> {
  const raw = await requestDevice();
  if (!raw) return undefined;
  return connect(raw);
}
