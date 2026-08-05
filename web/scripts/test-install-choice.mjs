// Which install path an APK takes. Getting this wrong either fails the install
// (pm install over a preinstalled system app) or silently writes over a system
// partition when a plain install was wanted — so the rule gets its own test.
//
// Paths are real ones read off a DeepMirror device; see the table below.
// install-target.ts has no imports of its own, so Node can strip its types and
// load it directly — no bundler in the loop for a pure-logic test.
const mod = await import(new URL("../src/adb/install-target.ts", import.meta.url).href);

let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

// [pm path output, expected: is this a system app we should overwrite in place?]
const cases = [
  ["/system_ext/priv-app/Dino/Dino.apk", true, "com.dm.ai.dino, as found on the device"],
  ["/system_ext/app/Talker/Talker.apk", true, "system_ext is where these actually live"],
  ["/system/app/Foo/Foo.apk", true, "classic /system"],
  ["/product/app/Foo/base.apk", true, "/product"],
  ["/vendor/app/Foo/base.apk", true, "/vendor"],
  ["/data/app/~~x==/com.dm.ai.piggycamp-y==/base.apk", false,
    "same com.dm.ai prefix but user-installed — must NOT be pushed to system"],
  ["/data/app/~~x==/com.android.documentsui-y==/base.apk", false, "ordinary app"],
  ["/systemfoo/app/Foo/base.apk", false,
    "a lookalike directory must not count as a system partition"],
  ["/system", false, "the bare directory is not an apk path"],
];

// systemApkPath talks to a device; exercise the classifier through a fake adb
// that just replays `pm path` output.
for (const [path, expected, why] of cases) {
  const got = mod.systemApkPathFrom(`package:${path}\n`);
  check(`${expected ? "system" : "normal "}  ${path}`, (got !== undefined) === expected, why);
}

// Split APKs report several lines; the base is the one to overwrite.
const split = mod.systemApkPathFrom(
  "package:/system_ext/app/Foo/split_config.arm64_v8a.apk\npackage:/system_ext/app/Foo/base.apk\n"
);
check("split APK picks base.apk", split === "/system_ext/app/Foo/base.apk", String(split));

// No such package: nothing to overwrite, so fall through to a normal install.
const none = mod.systemApkPathFrom("");
check("unknown package -> normal install", none === undefined, String(none));

// The prefix gate: only com.dm.ai packages are ever considered for a system push.
const sys = "package:/system_ext/app/Foo/base.apk\n";
check("com.dm.ai on system -> push", mod.shouldPushToSystem("com.dm.ai.dino", sys) !== undefined);
check("other vendor on system -> normal install",
  mod.shouldPushToSystem("com.android.settings", sys) === undefined,
  "a system app we do not own must not be overwritten");
check("unreadable package name -> normal install",
  mod.shouldPushToSystem(undefined, sys) === undefined);

console.log(fail ? `\n${fail} FAILED` : "\nINSTALL PATH SELECTION OK");
process.exit(fail ? 1 : 0);
