// App state. Two transports feed one device list:
//   * WebUSB sessions the page owns directly (src/adb/session.ts)
//   * devices the backend's adb server owns, reached over the relay
//     (src/adb/server.ts)
// Once connected, both are just an `Adb`, so nothing downstream cares which.

import type { Adb } from "@yume-chan/adb";
import { create } from "zustand";

import * as api from "./api";
import * as device from "./adb/device";
import { deviceInfo } from "./adb/device";
import * as server from "./adb/server";
import * as session from "./adb/session";
import { errorMessage, type Device, type DeviceInfo } from "./types";

// "convert" is the odd one out: it needs no device, so it stays reachable (and
// stays put) whether or not one is connected.
export type Tab = "device" | "apps" | "files" | "mirror" | "logcat" | "net" | "convert";

/**
 * Where to land after connecting. Always 设备 — except that yanking someone out
 * of 转码 would unmount a conversion that may be halfway through a few hundred
 * frames, and plugging in a phone is not a reason to throw that away.
 */
function tabAfterConnect(current: Tab): Tab {
  return current === "convert" ? "convert" : "device";
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
}

export interface Active {
  device: Device;
  adb: Adb;
  info?: DeviceInfo;
  /** Set for WebUSB sessions so we can close the underlying connection. */
  close?: () => Promise<void>;
}

interface State {
  health: api.Health | null;
  /** Why the backend is or isn't usable — distinguishes a bad token from "down". */
  backend: api.BackendStatus;
  /** Whether an adb server is reachable behind the relay. */
  serverReady: boolean;
  devices: Device[];
  active: Active | null;
  tab: Tab;
  busy: string | null;
  toasts: Toast[];

  init(): Promise<void>;
  /** Re-ask Cloudflare Access who we are and reflect it in the UI. */
  refreshIdentity(): Promise<void>;
  /** Drop the Access session; the internal entry points go with it. */
  signOut(): Promise<void>;
  refreshDevices(): Promise<void>;
  addUsbDevice(): Promise<void>;
  /** `quiet` suppresses the busy overlay and error toast, for automatic attempts. */
  select(device: Device, opts?: { quiet?: boolean }): Promise<void>;
  /** Connect without being asked, when there's an obvious device to pick. */
  autoConnect(): Promise<void>;
  /**
   * Recover from "an adb server owns this device" by switching to a local bridge
   * to that same adb server. Resolves true if the transport was switched.
   */
  rescueBusy(): Promise<boolean>;
  /** Rebuild the session for the currently selected device. */
  reconnect(): Promise<boolean>;
  /**
   * Run a device operation, reconnecting and retrying once if the transport
   * turned out to be stale.
   */
  runOnDevice<T>(label: string, fn: (adb: Adb) => Promise<T>): Promise<T>;
  /** A transport just proven alive, reconnecting first if the old one died. */
  liveAdb(label: string): Promise<Adb>;
  /** `adb root` / `adb unroot`, waiting for adbd to come back. */
  restartAdbd(mode: "root" | "unroot"): Promise<string>;
  /** Start watching for devices being plugged in and out. Returns a stop function. */
  watchDevices(): Promise<() => void>;
  /**
   * Get the device rooted and its system partition writable, and return a live
   * `Adb` for it. Callers that write to /system must go through this.
   */
  prepareSystemWrite(): Promise<Adb>;
  disconnect(): Promise<void>;
  setTab(tab: Tab): void;
  setBusy(label: string | null): void;
  toast(kind: Toast["kind"], message: string): void;
  dismiss(id: number): void;
  /** Re-read `getprop` for the active device (after a reboot, say). */
  reloadInfo(): Promise<void>;
}

/** Serial of the device connected last, so a revisit reconnects it silently. */
const LAST_DEVICE_KEY = "adbstudio.lastDevice";

let toastId = 0;

/**
 * Until when a vanishing transport is expected rather than alarming.
 *
 * `adb root` takes adbd down and brings it back, which looks exactly like a
 * replug from here — same empty device list, same dead transport. The difference
 * is that we asked for it, and the code that asked is already waiting to
 * reconnect; dropping the session underneath it would break the very flow it is
 * recovering.
 */
let churnUntil = 0;
const expectChurn = (ms: number) => {
  churnUntil = Date.now() + ms;
};
const expectingChurn = () => Date.now() < churnUntil;
/** Pending auto-dismiss timers, so a repeat can restart one instead of stacking. */
const toastTimers = new Map<number, number>();

/**
 * The device is held by an adb server — so reach it *through* that adb server.
 *
 * WebUSB and adb cannot both own a USB interface, and which of the two situations
 * a given machine is in isn't knowable in advance: a laptop with Android Studio
 * open needs the bridge, a borrowed machine with no SDK installed needs WebUSB
 * and has no bridge to offer. So don't ask the user to know either — try direct
 * first, and only reach for the bridge once the device actually comes back busy.
 *
 * Deliberately not probed on page load: reaching 127.0.0.1 from a hosted page
 * makes Chrome ask permission to access the local network, and a permission
 * prompt nobody asked for, on a machine where the bridge isn't even running, is
 * worse than the error it would pre-empt. After a click on "connect" it is
 * expected.
 *
 * Returns true if the bridge is now the active transport.
 */
async function fallBackToBridge(): Promise<boolean> {
  const previous = server.bridgeOverride();
  // Already pointed at a bridge and still busy: nothing left to switch to.
  if (previous) return false;
  server.setBridgeOverride(server.LOCAL_BRIDGE_URL);
  if (await server.serverAvailable()) return true;
  // Leave no override behind, or every later request would go to a bridge that
  // isn't there.
  server.setBridgeOverride(null);
  return false;
}

export const useStore = create<State>((set, get) => ({
  health: null,
  backend: { kind: "unreachable", detail: "not checked yet" },
  serverReady: false,
  devices: [],
  active: null,
  tab: "device",
  busy: null,
  toasts: [],

  async init() {
    const backend = await api.backendStatus();
    let health = backend.kind === "ok" ? backend.health : null;

    // Health is served on a public path, so Cloudflare injects no identity header
    // there and it always reports nobody. Ask on the Access-covered path instead,
    // or the page would keep offering "登录解锁" to someone already signed in.
    if (health?.features.accessIdentity) {
      const who = await api.identity();
      health = { ...health, user: who?.user ?? null, privileged: who?.privileged ?? false };
      // Identity in hand: the next sign-in click (after a sign-out, say) should
      // take the fast silent path again rather than the forced account re-pick
      // that a failed attempt leaves armed.
      if (who) api.signInSucceeded();
    }
    set({ backend, health });

    // A wrong token is easy to do (the URL takes one secret and people have
    // several) and silently degrades every backend feature, so say so outright
    // instead of leaving it to the self-check panel.
    if (backend.kind === "unauthorized") {
      get().toast(
        "error",
        "访问令牌无效：需要身份的功能不可用。请在“连接方式 / 环境自检”里填入服务端 server/.token 的内容（64 位十六进制）。"
      );
    }

    // Probe the relay when there is reason to think something is behind it: the
    // backend reports its own adb server, or the user has pointed us at a bridge
    // of their own (whose health this backend knows nothing about).
    if (health?.features.adbServer || server.bridgeOverride()) {
      set({ serverReady: await server.serverAvailable() });
    } else {
      set({ serverReady: false });
    }
    await get().refreshDevices();
    await get().autoConnect();
  },

  async refreshIdentity() {
    const health = get().health;
    if (!health?.features.accessIdentity) return;
    const who = await api.identity();
    set({
      health: { ...health, user: who?.user ?? null, privileged: who?.privileged ?? false },
    });
  },

  async signOut() {
    // Drop it here first rather than waiting for the round trip. Signing out has
    // to take the internal entry points with it *immediately*: the sign-out
    // navigation is two redirects away, and leaving the identity-gated features
    // on screen in the meantime reads as "it didn't work". Doubly so on the way
    // back — a restore from the back/forward cache would revive whatever state
    // was on screen when we left.
    const health = get().health;
    if (health) set({ health: { ...health, user: null, privileged: false } });
    await api.signOut();
  },

  async refreshDevices() {
    const found: Device[] = [];
    try {
      found.push(...(await session.listGrantedDevices()));
    } catch (e) {
      get().toast("error", `USB 设备枚举失败：${errorMessage(e)}`);
    }
    if (get().serverReady) {
      try {
        // A local bridge owns the user's USB devices too, and going through it
        // avoids fighting WebUSB for the interface — so take everything it has.
        // A remote backend only ever reports devices on its own network.
        found.push(...(await server.listServerDevices()));
      } catch {
        // The relay dropped; stop claiming the bridge works.
        set({ serverReady: false });
      }
    }

    // One physical device can appear twice (WebUSB *and* the bridge). Prefer the
    // bridge: it multiplexes, so it coexists with a running adb server.
    const bySerial = new Map<string, Device>();
    for (const d of found) {
      const existing = bySerial.get(d.serial);
      if (!existing || (existing.source === "webusb" && d.source === "bridge")) {
        bySerial.set(d.serial, d);
      }
    }

    // Keep the connected device's live state rather than the enumerated one.
    const active = get().active;
    const devices = [...bySerial.values()].map((d) =>
      active && d.serial === active.device.serial ? active.device : d
    );
    // An already-connected device may not show up in either list (WebUSB hides
    // claimed devices); make sure it stays visible.
    if (active && !devices.some((d) => d.serial === active.device.serial)) {
      devices.unshift(active.device);
    }
    set({ devices });
  },

  async addUsbDevice() {
    try {
      const raw = await session.requestDevice();
      if (!raw) return; // user cancelled the chooser

      // The chooser lists the phone whether or not this page already has it, and
      // picking one we are already using could only ever fail: an adb server or
      // this very tab is holding the USB interface, so `connect` comes back
      // "device busy" and the reply — go set up a bridge — is advice for a
      // problem the user doesn't have.
      const active = get().active;
      if (active?.device.serial === raw.serial) {
        get().toast("info", `${active.device.name} 已经连接了`);
        set({ tab: tabAfterConnect(get().tab) });
        return;
      }
      const viaBridge = get().devices.find(
        (d) => d.serial === raw.serial && d.source === "bridge" && d.state === "device"
      );
      if (viaBridge) {
        // Reachable through the bridge, which coexists with Android Studio;
        // claiming the interface directly would take the device away from it.
        await get().select(viaBridge);
        return;
      }

      set({ busy: "正在连接设备…" });
      const s = await session.connect(raw);
      set({
        active: { device: s.device, adb: s.adb, close: s.close },
        tab: tabAfterConnect(get().tab),
        busy: null,
      });
      get().toast("success", `已连接 ${s.device.name}`);
      void s.disconnected.then(() => {
        if (get().active?.device.serial === s.device.serial) {
          set({ active: null });
          get().toast("info", `${s.device.name} 已断开`);
          void get().refreshDevices();
        }
      });
      await get().reloadInfo();
      await get().refreshDevices();
    } catch (e) {
      set({ busy: null });
      if (e instanceof session.DeviceBusyError && (await get().rescueBusy())) return;
      get().toast("error", errorMessage(e));
    }
  },

  async rescueBusy() {
    set({ busy: "设备被 adb 占用，正在尝试本机桥接…" });
    const ok = await fallBackToBridge();
    if (!ok) {
      set({ busy: null });
      // Nothing automatic is left, so say exactly what a person can do about it
      // — both ways, with their costs. "Device busy" on its own sends people
      // hunting for a setting that doesn't exist.
      get().toast(
        "error",
        "设备被 adb 占用，本机也没有桥接在运行。两个办法：" +
          "① 退出 Android Studio 并执行 adb kill-server，让浏览器独占设备；" +
          "② 下载并运行本机桥接，就能和 Android Studio 同时使用 —— " +
          "点右上角齿轮，里面有对应系统的下载。"
      );
      return false;
    }
    set({ serverReady: true });
    await get().refreshDevices();
    // The bridge lists the same physical device under the same serial, so a
    // remembered one still matches; otherwise take the single device it offers.
    const viaBridge = get().devices.filter((d) => d.source === "bridge" && d.state === "device");
    const last = localStorage.getItem(LAST_DEVICE_KEY);
    const target = viaBridge.find((d) => d.serial === last) ?? (viaBridge.length === 1 ? viaBridge[0] : undefined);
    set({ busy: null });
    if (!target) {
      get().toast("info", "已切换到本机桥接，请在左侧选择设备。");
      return true;
    }
    await get().select(target);
    get().toast(
      "success",
      "设备被 adb 占用，已自动改用本机桥接 —— 可以和 Android Studio 同时使用。"
    );
    return true;
  },

  async select(device, opts) {
    if (get().active?.device.serial === device.serial) return;
    await get().disconnect();
    if (!opts?.quiet) set({ busy: `正在连接 ${device.name}…` });
    try {
      if (device.source === "bridge") {
        const adb = await server.connectServerDevice(device.serial);
        set({ active: { device: { ...device, state: "device" }, adb } });
      } else {
        const raw = await session.findGrantedDevice(device.serial);
        if (!raw) {
          throw new Error(
            "浏览器未授权该 USB 设备（可能已拔出）。点“连接 USB 设备”重新选择。"
          );
        }
        const s = await session.connect(raw);
        set({ active: { device: s.device, adb: s.adb, close: s.close } });
        void s.disconnected.then(() => {
          if (get().active?.device.serial === s.device.serial) {
            set({ active: null });
            void get().refreshDevices();
          }
        });
      }
      set({ busy: null, tab: tabAfterConnect(get().tab) });
      // Remember it so the next visit reconnects the same one without asking.
      localStorage.setItem(LAST_DEVICE_KEY, device.serial);
      await get().reloadInfo();
      await get().refreshDevices();
    } catch (e) {
      set({ busy: null });
      // Busy is worth rescuing even on an automatic attempt: switching transport
      // is exactly what the user would have to do by hand, and it is silent when
      // it works.
      if (e instanceof session.DeviceBusyError && (await get().rescueBusy())) return;
      // Any other automatic attempt must not greet you with an error dialog — the
      // device stays listed and clicking it shows the real reason.
      if (!opts?.quiet) get().toast("error", errorMessage(e));
    }
  },

  async autoConnect() {
    if (get().active) return;
    const devices = get().devices;
    // WebUSB devices are listed without a live state (we can't know it until we
    // open them), so treat any granted one as worth trying. Bridge devices report
    // real state, so only take the ready ones.
    const usable = devices.filter((d) => d.source === "webusb" || d.state === "device");
    if (usable.length === 0) return;

    const last = localStorage.getItem(LAST_DEVICE_KEY);
    const target =
      usable.find((d) => d.serial === last) ?? (usable.length === 1 ? usable[0] : undefined);
    // With several unfamiliar devices, picking one for you would be a guess.
    if (!target) return;

    await get().select(target, { quiet: true });
  },

  /**
   * Rebuild the session for the device we already have selected.
   *
   * The `Adb` object is bound to one transport, and a transport does not survive
   * adbd restarting, a replug, or an `adb kill-server`. Everything above this
   * layer holds an `Adb` from `active`, so recovery means replacing that object
   * rather than trying to repair it.
   */
  async reconnect() {
    const current = get().active?.device;
    if (!current) return false;
    const serial = current.serial;
    try {
      if (current.source === "bridge") {
        // Wait for the serial to be back in `device` state before asking for a
        // transport: asking too early gets a fresh "not found" instead.
        await server.waitForDevice(serial).catch(() => {});
        const adb = await server.connectServerDevice(serial);
        set({ active: { device: { ...current, state: "device" }, adb } });
      } else {
        const raw = await session.findGrantedDevice(serial);
        if (!raw) return false;
        const s = await session.connect(raw);
        set({ active: { device: s.device, adb: s.adb, close: s.close } });
      }
      await get().reloadInfo();
      return true;
    } catch {
      return false;
    }
  },

  async liveAdb(label) {
    // For work that isn't a single call — mirroring opens sockets and keeps them
    // for as long as it runs, so handing it a transport that died on the last
    // replug means a failure minutes deep instead of at the start. A round trip
    // that costs nothing settles the question first, and runOnDevice already
    // knows how to replace a stale transport rather than report its id number.
    return get().runOnDevice(label, async (adb) => {
      await device.currentUid(adb);
      const revived = get().active;
      if (!revived) throw new Error(`${label}失败：设备已断开`);
      return revived.adb;
    });
  },

  async runOnDevice(label, fn) {
    const active = get().active;
    if (!active) throw new Error("没有连接设备");
    try {
      return await fn(active.adb);
    } catch (e) {
      if (!device.isStaleTransport(e)) throw e;
      // The id in "no device with transport id '12'" is meaningless to the user;
      // what they want is for it to work. Reconnect and try once more.
      get().toast("info", `连接已失效，正在重连后重试${label}…`);
      if (!(await get().reconnect())) {
        throw new Error(`${label}失败：设备连接已断开，且重连失败。请检查数据线或重新选择设备。`);
      }
      const revived = get().active;
      if (!revived) throw new Error(`${label}失败：设备已断开`);
      return await fn(revived.adb);
    }
  },

  async restartAdbd(mode) {
    const active = get().active;
    if (!active) throw new Error("没有连接设备");

    // The transport is about to die on purpose. Tell the watchers, or they will
    // read it as the cable coming out and drop the session we are restarting.
    expectChurn(40_000);

    // The reply arrives, then adbd exits — so the socket dying here is success,
    // not failure. Only a refusal ("cannot run as root in production builds")
    // comes back as a readable message.
    let reply = "";
    try {
      reply = mode === "root" ? await device.root(active.adb) : await device.unroot(active.adb);
    } catch (e) {
      if (!device.isStaleTransport(e)) throw e;
      reply = "";
    }
    if (/cannot run as root|production build/i.test(reply)) {
      throw new Error(reply.trim());
    }

    set({ busy: "等待 adbd 重启…" });
    try {
      // Restarting takes a moment to even begin; without this the old transport
      // is often still listed and we would reconnect to a daemon about to die.
      await new Promise((r) => setTimeout(r, 800));
      if (!(await get().reconnect())) {
        throw new Error(
          `${mode} 已执行，但重连失败。设备可能正在重启 adbd —— 稍等片刻点刷新，或重新插拔。`
        );
      }
    } finally {
      set({ busy: null });
      churnUntil = 0;
    }
    void get().refreshDevices();
    return reply.trim() || `${mode} 完成，已重新连接`;
  },

  async prepareSystemWrite() {
    const active = get().active;
    if (!active) throw new Error("没有连接设备");

    // Skip the restart when adbd is already root: `adb root` on a rooted daemon
    // is a no-op that still tears down the transport, so doing it unconditionally
    // would make every system write pay a reconnect it doesn't need.
    const uid = await get()
      .runOnDevice("检查 root", (adb) => device.currentUid(adb))
      .catch(() => "");
    if (uid !== "0") {
      await get().restartAdbd("root");
    }

    const out = await get().runOnDevice("remount", (adb) => device.remount(adb));
    // remount reports refusal in its output rather than by failing.
    if (/not permitted|Permission denied|failed/i.test(out)) {
      throw new Error(`remount 失败：${out.trim()} —— 需要 userdebug 版本且已解锁`);
    }
    const revived = get().active;
    if (!revived) throw new Error("设备已断开");
    return revived.adb;
  },

  async watchDevices() {
    const stops: (() => void)[] = [];

    /**
     * The device we are holding is gone. Say so now.
     *
     * Keeping the session on screen after the cable comes out is worse than
     * useless: the device page still shows its model, storage and battery, and
     * every button on it fails on a transport the adb server has already
     * forgotten. Dropping it is also all the recovery needed — plugging back in
     * fires the same events that connected it the first time, and autoConnect
     * takes it from there.
     */
    const dropActive = async (why: string) => {
      const active = get().active;
      if (!active) return;
      await get().disconnect();
      get().toast("info", `${active.device.name} ${why}`);
      await get().refreshDevices();
    };

    // WebUSB tells the page directly when hardware appears or goes away.
    const onUsbChange = (e: Event) => {
      void (async () => {
        const gone = (e as USBConnectionEvent).device?.serialNumber;
        const active = get().active;
        if (
          e.type === "disconnect" &&
          active?.device.source === "webusb" &&
          gone === active.device.serial
        ) {
          await dropActive("已拔出");
        }
        await get().refreshDevices();
        await get().autoConnect();
      })();
    };
    if (navigator.usb) {
      navigator.usb.addEventListener("connect", onUsbChange);
      navigator.usb.addEventListener("disconnect", onUsbChange);
      stops.push(() => {
        navigator.usb.removeEventListener("connect", onUsbChange);
        navigator.usb.removeEventListener("disconnect", onUsbChange);
      });
    }

    // And the adb server pushes its list over host:track-devices.
    if (get().serverReady) {
      // Whether the selected device was present in the previous push. A device
      // that drops and comes back has a new transport id, so the session must be
      // rebuilt — proactively, on the event, rather than leaving the next action
      // to discover it the hard way and pay a failed attempt first.
      let selectedWasPresent = true;
      try {
        const stop = await server.trackDevices((list) => {
          void (async () => {
            const active = get().active;
            const ready = list.some(
              (d) => d.serial === active?.device.serial && d.state === "device"
            );
            const listed = list.some((d) => d.serial === active?.device.serial);
            await get().refreshDevices();
            if (active) {
              // Gone from the server's list entirely — unplugged, not merely
              // offline for a moment. `adb root` also empties the list briefly,
              // hence the churn window: dropping the session mid-restart would
              // undo exactly the recovery restartAdbd is in the middle of.
              if (!listed && active.device.source === "bridge" && !expectingChurn()) {
                await dropActive("已拔出");
                selectedWasPresent = false;
                return;
              }
              if (ready && !selectedWasPresent) {
                await get().reconnect();
              }
              selectedWasPresent = ready;
            } else {
              // A device that replaced the one we had selected should just work.
              await get().autoConnect();
            }
          })();
        });
        stops.push(stop);
      } catch {
        // Tracking is a convenience; losing it must not break the app.
      }
    }

    // Events are the fast path, not a guarantee. WebUSB fires no disconnect for a
    // device held open by a bridge, `host:track-devices` isn't running at all
    // without one, and either can be missed while a tab is backgrounded. So also
    // ask the device itself, on a timer: one `id -u`, which either answers or
    // tells us the transport is gone. Two seconds — a stale screen is worse than
    // a shell command that costs nothing, and the probe skips itself while one is
    // already in flight.
    let probing = false;
    const probe = async () => {
      const active = get().active;
      if (probing || !active || expectingChurn()) return;
      probing = true;
      try {
        await device.currentUid(active.adb);
      } catch (e) {
        // Only a dead transport counts. A busy or slow device is still a device.
        if (device.isStaleTransport(e) && get().active === active) {
          await dropActive("已断开");
        }
      } finally {
        probing = false;
      }
    };
    const beat = window.setInterval(() => void probe(), 2000);
    stops.push(() => clearInterval(beat));

    return () => {
      for (const stop of stops) stop();
    };
  },

  async disconnect() {
    const active = get().active;
    if (!active) return;
    set({ active: null });
    try {
      await active.close?.();
    } catch {
      /* already gone */
    }
  },

  async reloadInfo() {
    const active = get().active;
    if (!active) return;
    try {
      const info = await deviceInfo(active.adb);
      // Guard against the device having changed while we were reading props.
      if (get().active?.device.serial !== active.device.serial) return;
      set((s) => (s.active ? { active: { ...s.active, info } } : {}));
    } catch (e) {
      get().toast("error", `读取设备信息失败：${errorMessage(e)}`);
    }
  },

  setTab: (tab) => set({ tab }),
  setBusy: (busy) => set({ busy }),

  toast(kind, message) {
    // Retrying the same failed action is the normal thing to do, and each attempt
    // used to leave its own copy on screen until dismissed by hand — a corner
    // filling up with the same sentence. Repeats refresh the one already there.
    const existing = get().toasts.find((t) => t.kind === kind && t.message === message);
    const id = existing?.id ?? ++toastId;
    if (!existing) set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));

    // Errors get longer than the rest — they are worth reading twice — but they
    // do go. Nothing here is a record anyone comes back to.
    const timer = window.setTimeout(() => get().dismiss(id), kind === "error" ? 12000 : 4000);
    const previous = toastTimers.get(id);
    if (previous !== undefined) clearTimeout(previous);
    toastTimers.set(id, timer);
  },

  dismiss(id) {
    const timer = toastTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    toastTimers.delete(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Convenience for components that only run with a device connected. */
export function useActive(): Active {
  const active = useStore((s) => s.active);
  if (!active) throw new Error("useActive called with no device connected");
  return active;
}
