// 投屏小挂件：**只有投屏**，没有界面。
//
// 给 Dino 家具配置台用的。之前的做法是把整个 ADB Studio iframe 进去 —— 页签、文件、
// 应用、连接向导全跟着过去了，而对面只要一块能动的画面。这个入口把投屏那条链路
// （WebUSB 连接 + push scrcpy-server + WebCodecs 解码 + 触控回传）单独打成一个文件，
// 宿主页面自己给一个 <canvas>，别的什么都不带。
//
// 打包：`npm run build:mirror` → dist-mirror/dino-mirror.js（IIFE，挂 window.DinoMirror）。
// 宿主还要把 `scrcpy-server` 这个二进制放到自己的源下（见 start 的 serverUrl）——
// 它要被推到设备上跑，不能跨源取（会被私有网络/CORS 挡）。
//
// **自动连接**：`navigator.usb.getDevices()` 只返回「这个源已经授权过」的设备，
// 拿到就直接连、直接出画面，不用点任何按钮。一台都没授权过时才需要一次
// `requestDevice()` —— 那个浏览器选择框**必须由用户手势触发**，规范如此，
// 所以宿主要把 pick() 挂在一个按钮上。授权一次之后，以后刷新都是自动的。
import type { Adb } from "@yume-chan/adb";

import * as device_ from "./adb/device";
import { installApk } from "./adb/files";
import { sh, shell } from "./adb/shell";
import { MOTION, setScrcpyServerUrl, startMirror, webCodecsSupported, type MirrorSession } from "./adb/scrcpy";
import { connect, listGrantedDevices, findGrantedDevice, requestDevice, type Session } from "./adb/session";
import { DEFAULT_SCRCPY_OPTIONS } from "./types";

export type MirrorState =
  | { phase: "connecting" }
  /** 一台都没授权过：宿主该显示一个按钮，点了调 pick()。 */
  | { phase: "need-pick" }
  | { phase: "mirroring"; serial: string; name: string }
  | { phase: "error"; error: string };

interface StartOptions {
  canvas: HTMLCanvasElement;
  /** scrcpy-server 的地址，必须和宿主页面同源。默认 './scrcpy-server'。 */
  serverUrl?: string;
  onState?: (s: MirrorState) => void;
}

let session: Session | null = null;
let mirror: MirrorSession | null = null;
let opts: StartOptions | null = null;
let notify: (s: MirrorState) => void = () => undefined;

function wireInput(canvas: HTMLCanvasElement) {
  // 画面按 CSS 缩放过，这里要换算回设备像素（canvas 的 backing store 就是设备分辨率）。
  const point = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  };
  const send = (action: number) => (e: PointerEvent) => {
    if (!mirror) return;
    if (action === MOTION.Move && e.buttons === 0) return; // 悬停不是拖动
    e.preventDefault();
    const { x, y } = point(e);
    void mirror.touch(action, x, y, action === MOTION.Up ? 0 : 1).catch(() => undefined);
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    send(MOTION.Down)(e);
  });
  canvas.addEventListener("pointermove", send(MOTION.Move));
  canvas.addEventListener("pointerup", send(MOTION.Up));
  canvas.addEventListener("pointercancel", send(MOTION.Up));
  canvas.addEventListener("wheel", (e) => {
    if (!mirror) return;
    e.preventDefault();
    const { x, y } = point(e as unknown as PointerEvent);
    void mirror.scroll(x, y, -e.deltaX / 100, -e.deltaY / 100).catch(() => undefined);
  }, { passive: false });
}

async function attach(raw: Awaited<ReturnType<typeof requestDevice>>) {
  if (!raw || !opts) return;
  notify({ phase: "connecting" });
  session = await connect(raw);
  mirror = await startMirror(session.adb, opts.canvas, {
    ...DEFAULT_SCRCPY_OPTIONS,
    // 投屏是给人看摆家具的效果，不是跑分：1280 足够，压低一点省带宽和解码。
    maxSize: 1280,
    stayAwake: true,
  });
  notify({ phase: "mirroring", serial: session.device.serial, name: session.device.name });

  // 拔线 / 被本机 adb 抢走 / 设备重启，都走这里。**要主动收尾并回到可重连的状态**：
  // 不处理的话画面会冻在最后一帧，看着像卡死。
  void session.disconnected.then(() => {
    mirror = null;
    session = null;
    notify({ phase: "need-pick" });
    // 设备回来时多半还在已授权列表里，自动接回去，不用人再点一次。
    void retry();
  });
}

let retrying = false;
async function retry() {
  if (retrying) return;
  retrying = true;
  try {
    for (let i = 0; i < 60 && !session; i += 1) {
      const granted = await listGrantedDevices();
      const raw = granted[0] && (await findGrantedDevice(granted[0].serial));
      if (raw) {
        try {
          await attach(raw);
          return;
        } catch {
          /* 还没就绪，等下一轮 */
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    retrying = false;
  }
}

/** 自动连上已授权的设备并开始投屏。没有已授权设备时回 need-pick。 */
export async function start(o: StartOptions): Promise<void> {
  opts = { serverUrl: "./scrcpy-server", ...o };
  setScrcpyServerUrl(opts.serverUrl!);
  notify = o.onState ?? (() => undefined);
  wireInput(o.canvas);
  if (!window.isSecureContext || !navigator.usb) {
    notify({ phase: "error", error: "需要 https（WebUSB 只在安全上下文里可用）" });
    return;
  }
  // 解码只走 WebCodecs。Tango 还带一个 TinyH264 的软解兜底，但它是个 Worker，
  // 单文件打包之后那条路径是坏的（`new URL('/assets/worker-…')` 指到宿主的根上）——
  // 与其让它在某台机器上悄悄走进去然后黑屏，不如在这里明确报出来。
  if (!webCodecsSupported()) {
    notify({ phase: "error", error: "这个浏览器不支持 WebCodecs，投屏用不了（请用 Chrome / Edge）" });
    return;
  }
  try {
    const granted = await listGrantedDevices();
    if (!granted.length) return notify({ phase: "need-pick" });
    const raw = await findGrantedDevice(granted[0].serial);
    if (!raw) return notify({ phase: "need-pick" });
    await attach(raw);
  } catch (e) {
    notify({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

/** 弹浏览器的设备选择框。**必须在用户手势里调**（点击事件处理函数里）。 */
export async function pick(): Promise<void> {
  try {
    const raw = await requestDevice();
    if (raw) await attach(raw);
  } catch (e) {
    notify({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

/** 当前连着的设备（宿主判断「一键打包」能不能点）。 */
export function device(): { serial: string; name: string } | null {
  return session ? { serial: session.device.serial, name: session.device.name } : null;
}

/**
 * 拿到一个**已经 root、remount 过、且是新握手的** adb。
 *
 * `root:` 会重启 adbd，**这条 transport 是作为「成功」的一部分死掉的** —— 所以推包
 * 之前必须重新连一次，不能沿用手里这个（否则 push 报 "no device with transport id"）。
 * 重连不用自己写：`attach` 里挂的 disconnected 回调会把 retry() 拉起来，等它把
 * session 换成新的就行。
 */
async function prepareSystemWrite(): Promise<Adb> {
  if (!session) throw new Error("还没有连接设备");
  const before = session;

  // adbd 已经是 root 的话就别再 root 一次：那是个空操作，却照样要赔上一次重连。
  const uid = await device_.currentUid(session.adb).catch(() => "");
  if (uid !== "0") {
    try {
      await device_.root(session.adb);
    } catch (e) {
      // 断开就是它生效的样子，只有「不是 transport 断了」才算真失败。
      if (!device_.isStaleTransport(e)) throw e;
    }
    for (let i = 0; i < 60 && (!session || session === before); i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!session || session === before) {
      throw new Error("adbd 重启后没能重连上（设备可能正在重启，稍等再试）");
    }
  }

  // remount 不重启 adbd；它拒绝的时候是**在输出里说**，而不是抛错 —— 不看输出的话
  // 后面那个 push 会写进一个只读分区，看着全程成功、装上去却没变。
  const out = await device_.remount(session.adb);
  if (/not permitted|Permission denied|failed/i.test(out)) {
    throw new Error(`remount 失败：${out.trim()} —— 需要 userdebug 版本且已解锁`);
  }
  return session.adb;
}

/**
 * 部署一个**系统预装应用**并拉起指定页面 —— 配置台「打包 Filament」的最后一步。
 *
 * 和 install() 的区别只在于多传了 prepareSystemWrite：`com.dm.ai.*` 这类预装包
 * `pm install` 会被系统直接拒（persistent 应用更是明说 not updateable），
 * 只能覆盖写它在 /system_ext 上那个 APK。往哪写由 `pm path` 说了算（见
 * adb/install-target.ts），不是猜路径。
 */
export async function deploySystemApp(
  blob: Blob,
  name: string,
  cb: {
    onProgress?: (p: unknown) => void;
    onLog?: (line: string) => void;
    /** 装完往哪跳，如 `{ component: "pkg/.ui.FooActivity", extras: { K: "V" } }`。 */
    launch?: { component: string; extras?: Record<string, string> };
  } = {}
): Promise<void> {
  if (!session) throw new Error("还没有连接设备");
  const file = new File([blob], name, { type: "application/vnd.android.package-archive" });
  await installApk(session.adb, file, cb.onProgress, cb.onLog, prepareSystemWrite);

  // 上面那一步中间重连过，adb 换人了，这里必须重新取。
  if (!session) throw new Error("设备在部署过程中断开了");
  const adb = session.adb;

  const pkg = await import("./adb/apk").then((m) => m.apkPackageName(file)).catch(() => undefined);
  if (pkg) {
    // 推对了路径，ART 仍可能跑 /data/dalvik-cache 里的旧 AOT 产物（force-stop 不会
    // 让它失效），表现成「包推上去了、跑的还是老代码」，而且一点报错都没有。
    cb.onLog?.("强制重编 AOT（几十秒）…");
    await shell(adb, `cmd package compile -f -m speed ${sh(pkg)}`).catch(() => "");
    // persistent 应用被 force-stop 之后系统会自己拉回来；没回来之前 am start 会落空。
    for (let i = 0; i < 30; i += 1) {
      const pid = await shell(adb, `pidof ${sh(pkg)}`).catch(() => "");
      if (pid.trim()) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (cb.launch) {
    const extras = Object.entries(cb.launch.extras ?? {})
      .map(([k, v]) => `--es ${sh(k)} ${sh(v)}`)
      .join(" ");
    cb.onLog?.(`拉起 ${cb.launch.component}`);
    const out = await shell(adb, `am start -n ${sh(cb.launch.component)} ${extras}`.trim());
    if (/Error|does not exist/i.test(out)) {
      // 新增过 manifest 组件的话，系统应用的 manifest 只在开机时扫，必须重启一次。
      throw new Error(`拉起失败：${out.trim()}`);
    }
    cb.onLog?.("已拉起");
  }
}

/** 装一个 APK 并拉起来 —— 一键打包的最后一步走这里。 */
export async function install(
  blob: Blob,
  name: string,
  cb: { onProgress?: (p: unknown) => void; onLog?: (line: string) => void } = {}
): Promise<void> {
  if (!session) throw new Error("还没有连接设备");
  const adb: Adb = session.adb;
  const file = new File([blob], name, { type: "application/vnd.android.package-archive" });
  await installApk(adb, file, cb.onProgress, cb.onLog);
  const pkg = await import("./adb/apk").then((m) => m.apkPackageName(file)).catch(() => undefined);
  if (pkg) {
    await adb.subprocess.noneProtocol
      .spawnWaitText([`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`])
      .catch(() => undefined);
  }
}
