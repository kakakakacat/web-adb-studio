// The package name decides whether an APK is pushed over the system partition
// or installed normally, so reading it wrong picks the wrong install path
// entirely. Checked against aapt's answer for real APKs, not hand-made ones.
//
//   node scripts/test-apk-parse.mjs <dir-of-apks>
//
// Needs aapt on PATH or in the Android SDK to produce the expected values.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2];
const sdk = `${process.env.HOME}/Library/Android/sdk/build-tools/35.0.0/aapt`;
const aapt = existsSync(sdk) ? sdk : "aapt";

// Node 24 strips TypeScript types on import, so the module under test is the
// very file the app ships — no bundler step, and no hand-rolled type stripping
// that could quietly diverge from what vite produces.
const mod = await import(new URL("../src/adb/apk.ts", import.meta.url).href);

let fail = 0;
for (const name of readdirSync(dir).filter((f) => f.endsWith(".apk"))) {
  const path = join(dir, name);
  let expected = "";
  try {
    expected = execSync(`"${aapt}" dump badging "${path}"`, { maxBuffer: 1 << 28 })
      .toString()
      .match(/^package: name='([^']*)'/m)[1];
  } catch {
    console.log(`SKIP  ${name} — aapt could not read it`);
    continue;
  }
  const blob = new Blob([readFileSync(path)]);
  const got = await mod.apkPackageName(blob);
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${got ?? "(none)"}${ok ? "" : ` , aapt: ${expected}`}`);
}

// Not an APK at all: must return undefined, not throw and not guess. Installing
// a corrupt file should fall through to the normal path and let adb complain.
const junk = new Blob([new Uint8Array(5000).fill(0x41)]);
const j = await mod.apkPackageName(junk);
console.log(`${j === undefined ? "PASS" : "FAIL"}  non-APK input returns undefined — ${j}`);
if (j !== undefined) fail++;

console.log(fail ? `\n${fail} FAILED` : "\nAPK PARSING MATCHES AAPT");
process.exit(fail ? 1 : 0);
