// Live logcat.
//
// The output is a long-running stream, not a command that finishes, so this uses
// `spawn` and reads incrementally rather than `spawnWaitText`.
//
// Two things matter for it to stay usable:
//   * lines are delivered in batches — logcat can emit hundreds per second, and a
//     React update per line would lock the tab up
//   * the process must be killed when the view goes away, or it keeps streaming
//     (and holding an adb socket) forever

import type { Adb, AdbNoneProtocolProcess } from "@yume-chan/adb";

import { sh, shell } from "./shell";

export type LogLevel = "V" | "D" | "I" | "W" | "E" | "F";

export interface LogLine {
  id: number;
  time: string;
  pid: number;
  tid: number;
  level: LogLevel;
  tag: string;
  message: string;
}

export interface LogcatSession {
  stop(): Promise<void>;
}

export interface LogcatOptions {
  /** Only this package's process, resolved to a pid before starting. */
  packageName?: string;
  /** Drop everything below this level, done by logcat itself (cheaper than in JS). */
  minLevel?: LogLevel;
  /** Discard what's already buffered so the view starts at "now". */
  clearFirst?: boolean;
}

/** `-v threadtime`: "08-01 12:34:56.789  1234  5678 I Tag: message" */
const LINE =
  /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]*?)\s*:\s?(.*)$/;

let nextId = 0;

/** Parse one line, or undefined if it isn't a log record (banners, shell noise). */
export function parseLine(raw: string): LogLine | undefined {
  const m = LINE.exec(raw);
  if (!m) return undefined;
  return {
    id: (nextId += 1),
    time: m[1],
    pid: Number(m[2]),
    tid: Number(m[3]),
    level: m[4] as LogLevel,
    tag: m[5],
    message: m[6],
  };
}

/** Resolve a package to its running pid, or undefined if it isn't running. */
export async function pidOf(adb: Adb, packageName: string): Promise<number | undefined> {
  const out = await shell(adb, `pidof -s ${sh(packageName)}`);
  const pid = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

export async function clearLogcat(adb: Adb): Promise<void> {
  await shell(adb, "logcat -c");
}

/**
 * Start streaming. `onBatch` receives parsed lines in groups; `onEnd` fires if the
 * process exits on its own (device unplugged, logcat killed).
 */
export async function startLogcat(
  adb: Adb,
  options: LogcatOptions,
  onBatch: (lines: LogLine[]) => void,
  onEnd?: (reason: string) => void
): Promise<LogcatSession> {
  if (options.clearFirst) {
    // Best effort: a device that refuses `-c` should still stream.
    await clearLogcat(adb).catch(() => {});
  }

  const args = ["logcat", "-v", "threadtime"];
  if (options.packageName) {
    const pid = await pidOf(adb, options.packageName);
    if (pid === undefined) {
      throw new Error(`${options.packageName} 没有在运行，无法按进程过滤`);
    }
    args.push(`--pid=${pid}`);
  }
  if (options.minLevel && options.minLevel !== "V") {
    // "*:W" = warnings and above for every tag.
    args.push(`*:${options.minLevel}`);
  }

  let process: AdbNoneProtocolProcess;
  try {
    process = await adb.subprocess.noneProtocol.spawn(args);
  } catch (e) {
    throw new Error(`无法启动 logcat：${e instanceof Error ? e.message : String(e)}`);
  }

  let stopped = false;
  let pending: LogLine[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    onBatch(batch);
  };

  const push = (line: LogLine) => {
    pending.push(line);
    // Coalesce into ~10 updates/second regardless of how fast lines arrive.
    if (timer === undefined) timer = setTimeout(flush, 100);
  };

  void (async () => {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let carry = "";
    try {
      const reader = (
        process.output as unknown as ReadableStream<Uint8Array>
      ).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        // stream: true keeps multi-byte characters split across chunks intact.
        carry += decoder.decode(value, { stream: true });
        const parts = carry.split("\n");
        carry = parts.pop() ?? ""; // trailing partial line
        for (const part of parts) {
          const line = parseLine(part.replace(/\r$/, ""));
          if (line) push(line);
        }
      }
    } catch (e) {
      if (!stopped) onEnd?.(e instanceof Error ? e.message : String(e));
      return;
    }
    flush();
    if (!stopped) onEnd?.("logcat 已结束");
  })();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        await process.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
