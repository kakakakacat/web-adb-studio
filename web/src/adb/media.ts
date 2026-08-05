// Screenshots and input injection.

import type { Adb } from "@yume-chan/adb";

import { extractImage, sh, shell, shellBytes } from "./shell";
import { triggerDownload } from "./files";

/** PNG bytes of the current screen, via `screencap -p` over the `exec:` service. */
export async function screenshot(adb: Adb): Promise<Blob> {
  const out = await shellBytes(adb, "screencap -p");
  if (out.length === 0) throw new Error("截图失败：设备没有返回数据");
  // Rooted devices with an injector in the shell startup path print a few lines
  // before our output; without skipping them the PNG is corrupt.
  const png = extractImage(out);
  if (!png) {
    throw new Error("截图失败：设备返回的不是 PNG（可能被 shell 输出干扰）");
  }
  return new Blob([png as unknown as BlobPart], { type: "image/png" });
}

export async function screenshotToDownload(adb: Adb, deviceName: string): Promise<void> {
  const blob = await screenshot(adb);
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..+$/, "");
  const safe = deviceName.replace(/[^\w.\-]/g, "_") || "device";
  triggerDownload(blob, `${safe}-${stamp}.png`);
}

/**
 * Type text on the device. `input text` can't handle spaces or most punctuation
 * reliably, so we send it in chunks with escaping, optionally pacing the
 * characters (some IMEs drop input that arrives too fast).
 */
export async function sendText(
  adb: Adb,
  text: string,
  perCharDelayMs = 0
): Promise<void> {
  if (perCharDelayMs > 0) {
    for (const char of text) {
      await sendChunk(adb, char);
      await new Promise((r) => setTimeout(r, perCharDelayMs));
    }
    return;
  }
  await sendChunk(adb, text);
}

async function sendChunk(adb: Adb, chunk: string): Promise<void> {
  // `input text` treats %s as a space and chokes on a bare space argument.
  const escaped = chunk.replaceAll(" ", "%s");
  await shell(adb, `input text ${sh(escaped)}`);
}

export async function keyevent(adb: Adb, keyCode: number): Promise<void> {
  await shell(adb, `input keyevent ${keyCode}`);
}

/** The subset of Android keycodes the UI exposes as buttons. */
export const KEYCODES = {
  home: 3,
  back: 4,
  appSwitch: 187,
  power: 26,
  volumeUp: 24,
  volumeDown: 25,
  menu: 82,
  enter: 66,
  del: 67,
  wakeup: 224,
  sleep: 223,
} as const;
