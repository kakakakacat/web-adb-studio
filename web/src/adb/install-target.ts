// Deciding *how* to install an APK: over the system partition, or with
// `pm install`.
//
// Kept apart from files.ts, and free of imports, because it is pure decision
// logic over strings. Choosing wrong is expensive in both directions — a normal
// install of a preinstalled app fails or shadows it, and a system push writes
// over a partition when nobody asked — so this is the part that gets tested
// directly, without a device in the loop.

/**
 * Packages that ship preinstalled on DeepMirror devices.
 *
 * `pm install` cannot update one of these: the copy in the image stays where it
 * is and the install lands on the user partition, which either fails on
 * signature mismatch or shadows the system app with a second copy. The build has
 * to be written over the APK that is already there.
 */
export const SYSTEM_APP_PREFIX = "com.dm.ai";

/**
 * Directories that mean "this package is baked into the image".
 *
 * `/system_ext` is listed explicitly: every DeepMirror app on the device tested
 * against lives there, and a plain `startsWith("/system")` matched it only by
 * accident of the shared prefix — the same accident that would have matched a
 * hypothetical `/systemfoo`. Requiring a trailing slash makes both cases right
 * for the stated reason instead of by luck.
 */
export const SYSTEM_PARTITIONS = [
  "/system",
  "/system_ext",
  "/product",
  "/vendor",
  "/odm",
  "/apex",
];

export function onSystemPartition(apkPath: string): boolean {
  return SYSTEM_PARTITIONS.some((dir) => apkPath.startsWith(`${dir}/`));
}

/**
 * Given the output of `pm path <pkg>`, the APK to overwrite — or undefined when
 * the package is user-installed (or absent), which means install it normally.
 *
 * The `com.dm.ai` prefix alone is not enough to decide: such a build sideloaded
 * onto a developer's own phone lives in /data/app and must keep being installed
 * the ordinary way.
 */
export function systemApkPathFrom(pmPathOutput: string): string | undefined {
  const paths = pmPathOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("package:"))
    .map((line) => line.slice("package:".length))
    .filter((path) => path.length > 0);
  // A split APK reports several paths; the base is the one to overwrite.
  const apk = paths.find((p) => p.endsWith("base.apk")) ?? paths[0];
  if (!apk) return undefined;
  return onSystemPartition(apk) ? apk : undefined;
}

/** Should this package be pushed over the system partition? */
export function shouldPushToSystem(
  pkg: string | undefined,
  pmPathOutput: string
): string | undefined {
  if (!pkg?.startsWith(SYSTEM_APP_PREFIX)) return undefined;
  return systemApkPathFrom(pmPathOutput);
}
