// Thin helpers over Tango's subprocess service.
//
// We always use the *none* protocol (`shell:` service): it is supported on every
// Android version and merges stdout+stderr, which is exactly what the old
// `adb shell` based code parsed. The shell-v2 protocol would give us separate
// streams and exit codes, but it isn't available on older devices and none of
// the features here need it.

import type { Adb } from "@yume-chan/adb";

// Always pass the command as a *single-element array*. Given a plain string,
// Tango's spawner splits it on whitespace and re-joins it, which mangles the
// multi-line-ish icon script below; a one-element array is joined back to
// exactly what we wrote. `exec:` hands the whole string to the device's
// `sh -c`, so shell syntax (pipes, $(), quotes) still works.
/** Run a shell command and return its combined output. */
export function shell(adb: Adb, command: string): Promise<string> {
  return adb.subprocess.noneProtocol.spawnWaitText([command]);
}

/**
 * Run a shell command and return raw bytes. Safe for binary payloads
 * (`screencap -p`, `unzip -p`, `content read`) because `noneProtocol` uses the
 * `exec:` service — no pty, so no LF→CRLF mangling. This is the equivalent of
 * `adb exec-out`, which is what the native app used.
 */
export function shellBytes(adb: Adb, command: string): Promise<Uint8Array> {
  return adb.subprocess.noneProtocol.spawnWait([command]);
}

/** Escape a value for safe interpolation into a shell command. */
export function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Find where an image actually starts in command output, or -1.
 *
 * Necessary because some devices print to stdout before our command's output
 * does. A rooted phone with an injector/Magisk module in the shell startup path
 * emits lines like
 *
 *     [+] libc_path is /apex/com.android.runtime/lib64/bionic/libc.so
 *
 * ahead of every command, so `screencap -p` and `content read` come back as
 * "garbage, then a valid PNG". Checking only the first bytes rejects those as
 * non-images and the feature looks broken with no clue why.
 *
 * Scans a bounded prefix: the preamble is a few KB at most, and an unbounded scan
 * of a multi-megabyte screenshot would be wasted work.
 */
export function findImageStart(bytes: Uint8Array): number {
  const limit = Math.min(bytes.length, 256 * 1024);
  for (let i = 0; i + 8 <= limit; i += 1) {
    if (bytes[i] !== 0x89) continue;
    let hit = true;
    for (let j = 1; j < 8; j += 1) {
      if (bytes[i + j] !== PNG_MAGIC[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  // WebP: "RIFF" ???? "WEBP"
  for (let i = 0; i + 12 <= limit; i += 1) {
    if (
      bytes[i] === 0x52 && bytes[i + 1] === 0x49 && bytes[i + 2] === 0x46 && bytes[i + 3] === 0x46 &&
      bytes[i + 8] === 0x57 && bytes[i + 9] === 0x45 && bytes[i + 10] === 0x42 && bytes[i + 11] === 0x50
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * The image inside possibly-noisy command output, or undefined if there is none.
 * Trailing bytes are left alone — decoders stop at the image's own end marker.
 */
export function extractImage(bytes: Uint8Array): Uint8Array | undefined {
  const start = findImageStart(bytes);
  if (start < 0) return undefined;
  return start === 0 ? bytes : bytes.subarray(start);
}

/** Read every `getprop` key in one round-trip and index it. */
export async function getProps(adb: Adb): Promise<Map<string, string>> {
  const out = await shell(adb, "getprop");
  const props = new Map<string, string>();
  // Lines look like: [ro.product.model]: [Pixel 7]
  const re = /^\[([^\]]+)\]:\s*\[(.*)\]$/;
  for (const line of out.split("\n")) {
    const m = re.exec(line.trim());
    if (m) props.set(m[1], m[2]);
  }
  return props;
}
