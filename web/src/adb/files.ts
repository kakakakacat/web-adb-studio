// File transfer over the ADB sync protocol.
//
// The native app took OS paths from a drag-and-drop; in the browser we get
// `File` objects from an <input> or a DataTransfer, and stream them straight to
// the device — nothing is ever staged on a server.

import type { Adb } from "@yume-chan/adb";
import type { MaybeConsumable, ReadableStream as TangoReadable } from "@yume-chan/stream-extra";

import type { TransferProgress } from "../types";
import { apkNativeLibs, apkPackageName } from "./apk";
import { shouldPushToSystem, systemApkPathFrom } from "./install-target";
import { sh, shell } from "./shell";

/** Where files land when the user drops them on a device. */
export const DEFAULT_PUSH_DIR = "/sdcard/Download";

export type ProgressFn = (p: TransferProgress) => void;

/**
 * Wrap a byte stream so every chunk bumps a counter. Returns the stream to hand
 * to `sync.write`; `onBytes` fires with the running total.
 */
function countingStream(
  source: ReadableStream<Uint8Array>,
  onBytes: (total: number) => void
): TangoReadable<MaybeConsumable<Uint8Array>> {
  let total = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      onBytes(total);
      controller.enqueue(chunk);
    },
  });
  return source.pipeThrough(counter) as unknown as TangoReadable<
    MaybeConsumable<Uint8Array>
  >;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/**
 * Push one buffer or Blob to an exact remote path.
 *
 * Distinct from `pushFiles`, which puts files *into* a directory under their own
 * names. The system-app install has to land on a specific path — the APK already
 * in /system — so the destination is given in full.
 *
 * A Blob is streamed rather than buffered: a system APK can be a couple of
 * hundred megabytes, and reading that into a Uint8Array first would double the
 * memory for no reason.
 */
export async function pushBytes(
  adb: Adb,
  source: Uint8Array | Blob,
  remotePath: string,
  onProgress?: ProgressFn
): Promise<void> {
  const totalBytes = source instanceof Blob ? source.size : source.byteLength;
  const started = performance.now();
  const emit = (bytes: number, isComplete: boolean) => {
    if (!onProgress) return;
    const elapsed = (performance.now() - started) / 1000;
    onProgress({
      fileName: remotePath.slice(remotePath.lastIndexOf("/") + 1),
      index: 0,
      total: 1,
      percent: totalBytes > 0 ? bytes / totalBytes : 1,
      bytesTransferred: bytes,
      totalBytes,
      speedBytesPerSecond: elapsed > 0 ? bytes / elapsed : 0,
      isComplete,
      errorMessage: null,
    });
  };

  const base =
    source instanceof Blob
      ? source.stream()
      : new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(source);
            controller.close();
          },
        });

  const sync = await adb.sync();
  try {
    emit(0, false);
    await sync.write({
      filename: remotePath,
      file: countingStream(base as ReadableStream<Uint8Array>, (bytes) =>
        emit(bytes, false)
      ),
    });
    emit(totalBytes, true);
  } finally {
    await sync.dispose();
  }
}

/**
 * Push browser `File`s to a device directory, reporting per-file progress in the
 * same shape the native app emitted on its `transfer-progress` event.
 */
export async function pushFiles(
  adb: Adb,
  files: readonly File[],
  remoteDir: string = DEFAULT_PUSH_DIR,
  onProgress?: ProgressFn
): Promise<void> {
  const sync = await adb.sync();
  try {
    for (const [index, file] of files.entries()) {
      const started = performance.now();
      const emit = (bytes: number, isComplete: boolean, errorMessage: string | null) => {
        const elapsed = (performance.now() - started) / 1000;
        onProgress?.({
          fileName: file.name,
          index,
          total: files.length,
          percent: file.size > 0 ? bytes / file.size : 1,
          bytesTransferred: bytes,
          totalBytes: file.size,
          speedBytesPerSecond: elapsed > 0 ? bytes / elapsed : 0,
          isComplete,
          errorMessage,
        });
      };
      emit(0, false, null);

      try {
        await sync.write({
          filename: joinPath(remoteDir, file.name),
          file: countingStream(file.stream(), (bytes) => emit(bytes, false, null)),
          mtime: Math.floor(file.lastModified / 1000),
        });
        emit(file.size, true, null);
      } catch (e) {
        emit(0, true, e instanceof Error ? e.message : String(e));
        throw e;
      }
    }
  } finally {
    await sync.dispose();
  }
}

/** Map adb install output to a friendly message. Port of `parse_install_error`. */
const INSTALL_ERRORS: [string, string][] = [
  ["INSTALL_FAILED_ALREADY_EXISTS", "已安装同名应用但签名不同"],
  ["INSTALL_FAILED_INVALID_APK", "APK 文件无效"],
  ["INSTALL_FAILED_INSUFFICIENT_STORAGE", "设备存储空间不足"],
  ["INSTALL_FAILED_UPDATE_INCOMPATIBLE", "签名不匹配，请先卸载旧版本"],
  ["INSTALL_FAILED_OLDER_SDK", "APK 要求更高的 Android 版本"],
  ["INSTALL_FAILED_VERSION_DOWNGRADE", "不能降级安装，请先卸载"],
  ["INSTALL_FAILED_TEST_ONLY", "这是 test-only APK，需要 -t 参数"],
  ["INSTALL_FAILED_NO_MATCHING_ABIS", "APK 的 ABI 与设备不匹配"],
];

function installError(output: string): string {
  for (const [needle, message] of INSTALL_ERRORS) {
    if (output.includes(needle)) return message;
  }
  const failure = /Failure \[([^\]]+)\]/.exec(output);
  if (failure) return failure[1];
  return output.trim() || "安装失败";
}

/** Where a package's APK lives, if it lives on a system partition. */
export async function systemApkPath(adb: Adb, pkg: string): Promise<string | undefined> {
  return systemApkPathFrom(await shell(adb, `pm path ${sh(pkg)}`).catch(() => ""));
}

/**
 * Overwrite a preinstalled app in place — the web port of `push_system_app.sh`.
 *
 * Native libraries are refreshed separately and deliberately: the extracted
 * `lib/` directory next to the APK is not touched by overwriting `base.apk`, so
 * without this step a new build runs against the previous build's `.so` files
 * and crashes on load.
 */
export async function installSystemApk(
  adb: Adb,
  file: File,
  pkg: string,
  remoteApkPath: string,
  onProgress?: ProgressFn,
  onLog?: (line: string) => void
): Promise<void> {
  onLog?.("以系统应用方式安装（覆盖系统分区）");
  // Root and remount are NOT done here. `adb root` restarts adbd, which kills the
  // very transport this function was handed — the push that followed then died
  // with "no device with transport id". Getting root, waiting for the daemon and
  // acquiring a fresh transport belongs to the caller (store.prepareSystemWrite),
  // which hands in an `adb` that is already rooted and writable.
  onLog?.(`推送到 ${remoteApkPath}…`);
  await pushBytes(adb, file, remoteApkPath, (p) =>
    onProgress?.({ ...p, fileName: file.name })
  );
  await shell(adb, "sync").catch(() => "");

  // Verify rather than assume: remount can fail silently on a locked device and
  // the push then writes nothing useful, which would otherwise look like success
  // until the app failed to change.
  const size = await shell(adb, `stat -c %s ${sh(remoteApkPath)} 2>/dev/null`).catch(() => "");
  const written = Number.parseInt(size.trim(), 10);
  if (Number.isFinite(written) && written !== file.size) {
    throw new Error(
      `写入系统分区失败：设备上是 ${written} 字节，本地是 ${file.size} 字节。` +
        "可能是 remount 没成功（设备未解锁 / 非 userdebug 版本）。"
    );
  }

  const remoteDir = remoteApkPath.slice(0, remoteApkPath.lastIndexOf("/"));
  const libs = await apkNativeLibs(file).catch(() => []);
  if (libs.length > 0) {
    onLog?.(`刷新 ${libs.length} 个 native 库…`);
    const libDir = `${remoteDir}/lib/arm64`;
    await shell(adb, `mkdir -p ${sh(libDir)}`);
    for (const lib of libs) {
      await pushBytes(adb, lib.bytes, `${libDir}/${lib.name}`);
    }
    await shell(adb, "sync").catch(() => "");
  }

  onLog?.("强制停止应用，下次启动生效");
  await shell(adb, `am force-stop ${sh(pkg)}`).catch(() => "");
  onLog?.("安装成功（系统应用）");
}

/**
 * Install an APK, choosing how based on what the APK is.
 *
 * A DeepMirror preinstalled app is written over its copy on the system
 * partition; everything else goes through `pm install`. The decision needs the
 * package name before anything is pushed, which is why the APK is parsed in the
 * browser (see adb/apk.ts) rather than asking the device.
 *
 * `onProgress` covers the upload; the install step itself has no progress to
 * report, so it emits a final 100% event once `pm` returns.
 */
export async function installApk(
  adb: Adb,
  file: File,
  onProgress?: ProgressFn,
  onLog?: (line: string) => void,
  /**
   * Called only when the APK turns out to need a system push: must return an
   * `adb` that is rooted, remounted and freshly connected. Without it a system
   * app is installed the ordinary way, which is what a caller with no way to
   * root should do.
   */
  prepareSystemWrite?: () => Promise<Adb>
): Promise<void> {
  const pkg = await apkPackageName(file);
  if (pkg) onLog?.(`包名 ${pkg}`);
  if (pkg) {
    const systemPath = shouldPushToSystem(
      pkg,
      await shell(adb, `pm path ${sh(pkg)}`).catch(() => "")
    );
    if (systemPath) {
      if (!prepareSystemWrite) {
        onLog?.("这是系统预装应用，但当前无法取得 root —— 按普通应用安装");
      } else {
        onLog?.("获取 root 并重新挂载…");
        const rooted = await prepareSystemWrite();
        return installSystemApk(rooted, file, pkg, systemPath, onProgress, onLog);
      }
    }
  }
  const remote = `/data/local/tmp/${file.name.replace(/[^\w.\-]/g, "_")}`;
  onLog?.(`推送 ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…`);
  await pushFiles(adb, [file], "/data/local/tmp", (p) =>
    onProgress?.({ ...p, fileName: file.name })
  );

  onLog?.("安装中…");
  const out = await shell(adb, `pm install -r -d ${sh(remote)}`);
  await shell(adb, `rm -f ${sh(remote)}`);

  if (!out.includes("Success")) {
    const message = installError(out);
    onLog?.(`失败：${message}`);
    throw new Error(message);
  }
  onLog?.("安装成功");
}

/** Pull a file off the device and hand it to the browser as a download. */
export async function pullToDownload(
  adb: Adb,
  remotePath: string,
  onBytes?: (bytes: number) => void
): Promise<void> {
  const sync = await adb.sync();
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = (sync.read(remotePath) as unknown as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      onBytes?.(total);
    }
    triggerDownload(
      new Blob(chunks as BlobPart[]),
      remotePath.split("/").pop() || "download"
    );
  } finally {
    await sync.dispose();
  }
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke on the next tick so the click has been dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** List a device directory (used by the on-device file browser). */
export async function listDir(adb: Adb, path: string) {
  const sync = await adb.sync();
  try {
    return await sync.readdir(path);
  } finally {
    await sync.dispose();
  }
}
