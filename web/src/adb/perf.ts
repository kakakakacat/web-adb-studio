// Per-app performance sampling: CPU, memory, and frame timing.
//
// Everything here is polled, because Android exposes these as `dumpsys` snapshots
// rather than streams. One sample = a few shell round-trips, so the caller decides
// the interval (2s is a reasonable default).
//
// Frame stats matter most for the game builds: `gfxinfo` reports how many frames
// missed their deadline, which is what "feels laggy" actually means.

import type { Adb } from "@yume-chan/adb";

import { sh, shell } from "./shell";

export interface Sample {
  /** ms since page load, for plotting. */
  at: number;
  /** Percent of one core, as `top` reports it — can exceed 100 on multi-core. */
  cpu?: number;
  /** Total PSS in MB: the fairest single number for "memory this app costs". */
  memoryMb?: number;
  /** Frames rendered since the app started (cumulative). */
  frames?: number;
  /** Of those, how many missed the deadline (cumulative). */
  jankyFrames?: number;
  /** Janky share of the frames drawn since the previous sample. */
  jankPercent?: number;
}

/**
 * CPU% for a pid via `top`.
 *
 * `-n 1` takes one iteration; `-b` is batch mode so there are no escape codes to
 * strip. The column layout varies between Android versions, so the value is found
 * by position from the right rather than a fixed index.
 */
async function sampleCpu(adb: Adb, pid: number): Promise<number | undefined> {
  const out = await shell(adb, `top -b -n 1 -p ${pid} 2>/dev/null`);
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== String(pid)) continue;
    // Layout: PID USER PR NI VIRT RES SHR S[%CPU] %MEM TIME+ ARGS
    const s = cols.findIndex((c) => /^[SRDZTI]$/.test(c));
    const raw = s >= 0 ? cols[s + 1] : undefined;
    const cpu = Number.parseFloat((raw ?? "").replace("%", ""));
    if (Number.isFinite(cpu)) return cpu;
  }
  return undefined;
}

/** Total PSS in MB from `dumpsys meminfo`. */
async function sampleMemory(adb: Adb, pkg: string): Promise<number | undefined> {
  const out = await shell(adb, `dumpsys meminfo ${sh(pkg)} 2>/dev/null`);
  // "TOTAL PSS:   123456" (newer) or a "TOTAL" row whose first number is PSS.
  const direct = /TOTAL\s+PSS:\s*(\d+)/i.exec(out);
  if (direct) return Number(direct[1]) / 1024;
  const row = /^\s*TOTAL\s+(\d+)/im.exec(out);
  return row ? Number(row[1]) / 1024 : undefined;
}

/** Cumulative frame counters from `dumpsys gfxinfo`. */
async function sampleFrames(
  adb: Adb,
  pkg: string
): Promise<{ frames?: number; janky?: number }> {
  const out = await shell(adb, `dumpsys gfxinfo ${sh(pkg)} 2>/dev/null`);
  const total = /Total frames rendered:\s*(\d+)/i.exec(out);
  const janky = /Janky frames:\s*(\d+)/i.exec(out);
  return {
    frames: total ? Number(total[1]) : undefined,
    janky: janky ? Number(janky[1]) : undefined,
  };
}

export async function pidOf(adb: Adb, pkg: string): Promise<number | undefined> {
  const out = await shell(adb, `pidof -s ${sh(pkg)}`);
  const pid = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/**
 * Take one sample. `previous` is used to turn the cumulative frame counters into a
 * per-interval jank percentage — the absolute totals only ever grow and say
 * nothing about how it's behaving right now.
 */
export async function sample(
  adb: Adb,
  pkg: string,
  previous?: Sample
): Promise<Sample> {
  const pid = await pidOf(adb, pkg);
  if (pid === undefined) throw new Error(`${pkg} 没有在运行`);

  // Sequential, not parallel: these share one adb connection and interleaving them
  // makes each round-trip slower rather than faster.
  const cpu = await sampleCpu(adb, pid).catch(() => undefined);
  const memoryMb = await sampleMemory(adb, pkg).catch(() => undefined);
  const frames: { frames?: number; janky?: number } = await sampleFrames(adb, pkg).catch(
    () => ({})
  );

  let jankPercent: number | undefined;
  if (
    previous?.frames !== undefined &&
    previous.jankyFrames !== undefined &&
    frames.frames !== undefined &&
    frames.janky !== undefined
  ) {
    const drawn = frames.frames - previous.frames;
    const missed = frames.janky - previous.jankyFrames;
    // A counter reset (app restarted) shows up as a negative delta — skip it.
    if (drawn > 0 && missed >= 0) jankPercent = (missed / drawn) * 100;
  }

  return {
    at: performance.now(),
    cpu,
    memoryMb,
    frames: frames.frames,
    jankyFrames: frames.janky,
    jankPercent,
  };
}

/** Reset gfxinfo's counters, so the next interval starts clean. */
export async function resetFrameStats(adb: Adb, pkg: string): Promise<void> {
  await shell(adb, `dumpsys gfxinfo ${sh(pkg)} reset`);
}
