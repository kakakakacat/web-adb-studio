// Unit test for locating an image inside noisy shell output.
//
// Can't be checked against a normal device: a clean shell emits nothing extra, so
// the bug only shows on phones whose shell startup prints diagnostics (rooted /
// Magisk / injector). Real captured noise is used below.
//
//   node scripts/test-image-extract.mjs

import { findImageStart, extractImage } from "../src/adb/shell.ts";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // magic
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, // RIFF + size
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, // WEBP VP8
]);

// Verbatim from the affected device's diagnostic output.
const NOISE = new TextEncoder().encode(
  "[+] libc_path is /apex/com.android.runtime/lib64/bionic/libc.so\n" +
    "[+] linker_path is /apex/com.android.runtime/bin/linker64\n" +
    "[+] libdl_path is /apex/com.android.runtime/lib64/bionic/libdl.so\n"
);

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

check("clean PNG found at 0", findImageStart(PNG) === 0);
check("clean WebP found at 0", findImageStart(WEBP) === 0);

const noisyPng = concat(NOISE, PNG);
check(
  "PNG after injector noise is located",
  findImageStart(noisyPng) === NOISE.length,
  `offset ${findImageStart(noisyPng)} (expected ${NOISE.length})`
);
const extracted = extractImage(noisyPng);
check(
  "extracted bytes start with the PNG magic",
  extracted !== undefined && extracted.length === PNG.length && extracted[0] === 0x89,
  extracted ? `${extracted.length} bytes` : "undefined"
);

check("WebP after noise is located", findImageStart(concat(NOISE, WEBP)) === NOISE.length);

// Must still reject genuine failures, or a provider error becomes a broken icon.
const providerError = new TextEncoder().encode(
  "Error while accessing provider:kakacat.icu.iconhelper.icons\n"
);
check("provider error is not an image", extractImage(providerError) === undefined);
check("empty output is not an image", extractImage(new Uint8Array()) === undefined);
check(
  "noise alone is not an image",
  extractImage(NOISE) === undefined,
  "would otherwise produce a corrupt data URL"
);

// A 0x89 byte that isn't the PNG magic must not be mistaken for one.
check(
  "near-miss magic rejected",
  extractImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])) === undefined
);

// Guard the bounded scan: an image beyond the window is deliberately not found.
const farAway = concat(new Uint8Array(300 * 1024), PNG);
check(
  "scan is bounded (image past 256 KB not searched)",
  findImageStart(farAway) === -1,
  "keeps a multi-MB screenshot from being scanned end to end"
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
