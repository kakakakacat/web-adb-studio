// Domain types for the web build. Carried over from the Tauri app's ipc/types.ts
// so the UI shapes stay familiar, minus the ones that only made sense for a
// native host (local file paths, updater, log-file paths).

export type DeviceState = "device" | "unauthorized" | "offline" | "connecting";

export type ConnectionType = "usb" | "wifi";

/**
 * How we reach a device.
 *
 * `webusb` — the page claims the USB interface itself. No extra software, but it
 * conflicts with a local adb server: only one host process can hold the
 * interface, so the user must `adb kill-server` first.
 *
 * `bridge` — we go through a real adb server via the backend's WebSocket relay.
 * That server owns the USB interface and multiplexes clients, so the page,
 * `adb shell` in a terminal and Android Studio can all use the device at once.
 */
export type DeviceSource = "webusb" | "bridge";

export interface Device {
  /** Stable key for React lists — source + serial, since both can list one device. */
  id: string;
  serial: string;
  /** USB product string, e.g. "Pixel 7". Available before authorizing. */
  name: string;
  state: DeviceState;
  connection: ConnectionType;
  source: DeviceSource;
  model?: string;
  product?: string;
}

export interface DeviceInfo {
  serial: string;
  model?: string;
  brand?: string;
  androidVersion?: string;
  sdkVersion?: string;
  product?: string;
  abi?: string;
  bootloaderUnlocked?: boolean;
}

export type RebootMode = "system" | "recovery" | "bootloader" | "fastboot";

/**
 * `dm` lists DeepMirror packages by name prefix rather than by how they were
 * installed. It replaces `thirdParty` in the UI for signed-in colleagues: on a
 * company device the interesting apps are preinstalled, so `pm list -3` shows
 * everything except the ones they came to look at.
 */
export type AppListFilter = "all" | "thirdParty" | "system" | "disabled" | "dm";

export interface InstalledApp {
  packageName: string;
  versionName?: string;
  versionCode?: number;
  installTime?: string;
  updateTime?: string;
  isSystemApp: boolean;
  isEnabled: boolean;
}

export interface ScrcpyOptions {
  maxSize: number;
  maxFps: number;
  stayAwake: boolean;
  showTouches: boolean;
  turnScreenOff: boolean;
}

export const DEFAULT_SCRCPY_OPTIONS: ScrcpyOptions = {
  maxSize: 1280,
  maxFps: 60,
  stayAwake: true,
  showTouches: false,
  turnScreenOff: false,
};

/** Progress for a push/pull/install transfer. */
export interface TransferProgress {
  fileName: string;
  index: number;
  total: number;
  /** 0..1 */
  percent: number;
  bytesTransferred: number;
  totalBytes: number;
  speedBytesPerSecond: number;
  isComplete: boolean;
  errorMessage: string | null;
}

// --- remote files (served by the backend; browsers can't SSH) -------------
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
