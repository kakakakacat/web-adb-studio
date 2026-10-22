// 嵌入模式：把这个页面当作**别的内网工具里的一栏**。
//
// 现在的使用者是 Dino 家具配置台：右边那一栏 iframe 进来这个页面，人在自己电脑上
// 插一台手机，配置台点「一键打包」出 APK 之后，把 APK 的字节 postMessage 过来，
// 这边负责装进去、并且把投屏画面摆在那儿。
//
// 为什么非得是 iframe + postMessage，不能让配置台自己去装：
//   - **WebUSB 只在浏览器里**。设备插在使用者自己的电脑上，服务端（NAS 上的容器）
//     根本看不见它，adb 那一套在这里没有位置。
//   - **APK 不能由本页面去取**。这个站点是公网 origin，去拉内网地址会被 Chrome 的
//     私有网络访问检查挡掉（ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS），
//     证书和 CORS 都救不了。所以字节必须由那个内网页面取好、递进来。
//   - 反过来，WebUSB 要求**整条祖先链都是安全上下文**，所以嵌它的那个页面也必须是
//     https —— 这是配置台搬到 https 的原因，不是可选项。
//
// 消息都带 `adbstudio:` 前缀，且**只认白名单里的 origin**：这条通道能往设备上装应用，
// 谁都能发就等于把连着的手机交出去了。
import type { Adb } from "@yume-chan/adb";

import { apkPackageName } from "./adb/apk";
import { installApk } from "./adb/files";
import { shell } from "./adb/shell";
import { useStore } from "./store";

/** 允许嵌入并驱动这个页面的上级。新增使用方就往这里加。 */
const ALLOWED_PARENTS = [
  /^https:\/\/deepmirror\.kakacat\.net(:\d+)?$/,
  /^https:\/\/deepmirror\.kakacat\.icu(:\d+)?$/,
  // 本机开发（vite dev / 配置台本地跑）时用
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

export type EmbedIn =
  | { type: "adbstudio:ping" }
  /** 装一个 APK。blob 是结构化克隆过来的，不会复制一份 276MB 的字节。 */
  | { type: "adbstudio:install"; blob: Blob; name?: string; launch?: boolean }
  | { type: "adbstudio:launch"; pkg: string };

export function isEmbed(): boolean {
  return new URLSearchParams(location.search).get("embed") === "1";
}

function parentOrigin(): string | null {
  // referrer 是上级页面的地址；同源策略下这是唯一能拿到它 origin 的途径。
  try {
    const o = document.referrer ? new URL(document.referrer).origin : "";
    return o && ALLOWED_PARENTS.some((re) => re.test(o)) ? o : null;
  } catch {
    return null;
  }
}

function post(msg: Record<string, unknown>, origin: string | null) {
  // 没有可信上级就不发：宁可让对面收不到，也不要把设备信息广播给任意嵌入者。
  if (!origin) return;
  window.parent?.postMessage(msg, origin);
}

function deviceInfo() {
  const a = useStore.getState().active;
  if (!a) return null;
  return { serial: a.device.serial, name: a.device.name ?? "", state: a.device.state ?? "" };
}

async function launch(adb: Adb, pkg: string) {
  // monkey 比 `am start` 省事：不用知道入口 Activity 叫什么。
  await shell(adb, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`).catch(() => undefined);
}

/**
 * 装起消息通道。返回一个卸载函数（App 在 useEffect 里用）。
 * 非嵌入模式下什么都不做。
 */
export function initEmbedBridge(): () => void {
  if (!isEmbed()) return () => undefined;
  const origin = parentOrigin();

  const onMessage = async (e: MessageEvent) => {
    if (!origin || e.origin !== origin) return;
    const msg = e.data as EmbedIn | undefined;
    if (!msg || typeof msg !== "object" || !String(msg.type ?? "").startsWith("adbstudio:")) return;

    if (msg.type === "adbstudio:ping") {
      post({ type: "adbstudio:state", device: deviceInfo() }, origin);
      return;
    }

    const active = useStore.getState().active;
    if (!active) {
      post({ type: "adbstudio:install-done", ok: false, error: "还没有连接设备" }, origin);
      return;
    }

    if (msg.type === "adbstudio:launch") {
      await launch(active.adb, msg.pkg);
      return;
    }

    if (msg.type === "adbstudio:install") {
      const name = msg.name || "app.apk";
      const file = new File([msg.blob], name, { type: "application/vnd.android.package-archive" });
      try {
        await installApk(
          active.adb,
          file,
          // 推包要几十秒，没有进度的话对面只能干等一个转圈。
          (p) => post({ type: "adbstudio:install-progress", ...p }, origin),
          (line) => post({ type: "adbstudio:install-log", line }, origin)
        );
        // 装完顺手拉起来：包名从 APK 里读，不写死 —— 这条通道以后未必只装那一个包。
        if (msg.launch !== false) {
          const pkg = await apkPackageName(file).catch(() => undefined);
          if (pkg) await launch(active.adb, pkg);
        }
        post({ type: "adbstudio:install-done", ok: true, name }, origin);
      } catch (err) {
        post({
          type: "adbstudio:install-done",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }, origin);
      }
    }
  };

  window.addEventListener("message", onMessage);
  // 设备插拔要主动告诉上级：配置台的「一键打包」按钮据此决定能不能点。
  const unsub = useStore.subscribe((s, prev) => {
    if (s.active?.device.serial !== prev.active?.device.serial) {
      post({ type: "adbstudio:state", device: deviceInfo() }, origin);
    }
  });
  post({ type: "adbstudio:ready", device: deviceInfo() }, origin);

  return () => {
    window.removeEventListener("message", onMessage);
    unsub();
  };
}
