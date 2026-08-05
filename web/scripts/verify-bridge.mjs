// End-to-end verification of the *bridge* path against a real device, without a
// browser: it wires Tango's AdbServerClient to the backend relay over a
// WebSocket, exactly like src/adb/server.ts does in the page, then runs the same
// read-only commands the UI relies on.
//
//   node scripts/verify-bridge.mjs [ws://127.0.0.1:7070/api/adb]
//
// Read-only by design — nothing here installs, uninstalls, reboots or writes.

import { Adb, AdbServerClient } from "@yume-chan/adb";
import { MaybeConsumable } from "@yume-chan/stream-extra";

const url = process.argv[2] ?? "ws://127.0.0.1:7070/api/adb";

class RelayConnection {
  static async open() {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`cannot connect ${url}`));
    });
    return new RelayConnection(socket);
  }

  constructor(socket) {
    this.socket = socket;
    let done;
    this.closed = new Promise((resolve) => {
      done = () => resolve(undefined);
    });

    this.readable = new ReadableStream({
      start(controller) {
        socket.onmessage = (e) => controller.enqueue(new Uint8Array(e.data));
        socket.onclose = () => {
          try {
            controller.close();
          } catch {}
          done();
        };
        socket.onerror = () => {
          controller.error(new Error("relay socket error"));
          done();
        };
      },
      cancel() {
        socket.close();
      },
    });

    this.writable = new MaybeConsumable.WritableStream({
      write(chunk) {
        socket.send(new Uint8Array(chunk).buffer);
      },
    });
  }

  close() {
    this.socket.close();
  }
}

const client = new AdbServerClient({
  connect: () => RelayConnection.open(),
  addReverseTunnel: () => {
    throw new Error("unsupported");
  },
  removeReverseTunnel: () => {},
  clearReverseTunnels: () => {},
});

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const version = await client.getVersion();
check("adb server version via relay", version > 0, String(version));

const devices = await client.getDevices();
check("device list", devices.length > 0, `${devices.length} device(s)`);
if (devices.length === 0) {
  console.log("\nNo device attached — plug one in to verify the rest.");
  process.exit(failures);
}

const target = devices.find((d) => d.state === "device") ?? devices[0];
console.log(`\nUsing ${target.serial} (${target.model ?? "?"}), state=${target.state}\n`);

const transport = await client.createTransport({ serial: target.serial });
const adb = new Adb(transport);

// --- the same calls the UI makes -----------------------------------------

const shell = (cmd) => adb.subprocess.noneProtocol.spawnWaitText([cmd]);

const props = await shell("getprop");
const parsed = new Map();
for (const line of props.split("\n")) {
  const m = /^\[([^\]]+)\]:\s*\[(.*)\]$/.exec(line.trim());
  if (m) parsed.set(m[1], m[2]);
}
check("getprop parses (src/adb/shell.ts)", parsed.size > 50, `${parsed.size} props`);
check(
  "model / android version readable",
  Boolean(parsed.get("ro.product.model")),
  `${parsed.get("ro.product.model")} / Android ${parsed.get("ro.build.version.release")} / ${parsed.get("ro.build.type")}`
);

const packages = (await shell("pm list packages -3"))
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("package:"))
  .map((l) => l.slice(8));
check("pm list packages -3", packages.length > 0, `${packages.length} third-party`);

if (packages.length > 0) {
  const dump = await shell(`dumpsys package '${packages[0]}'`);
  check(
    "dumpsys package has versionName",
    dump.includes("versionName="),
    packages[0]
  );
}

// Binary safety: `exec:` must not mangle LF, or PNGs arrive corrupt.
const png = await adb.subprocess.noneProtocol.spawnWait(["screencap -p"]);
const isPng =
  png.length > 8 &&
  png[0] === 0x89 &&
  png[1] === 0x50 &&
  png[2] === 0x4e &&
  png[3] === 0x47 &&
  png[4] === 0x0d &&
  png[5] === 0x0a;
check(
  "screencap -p returns intact PNG (binary-safe exec:)",
  isPng,
  `${png.length} bytes, magic ${[...png.slice(0, 4)].map((b) => b.toString(16)).join(" ")}`
);

// Sync protocol: list a directory the way the Files panel does.
const sync = await adb.sync();
try {
  const entries = await sync.readdir("/sdcard");
  check("sync readdir /sdcard", entries.length > 0, `${entries.length} entries`);
} finally {
  await sync.dispose();
}

await adb.close();

console.log(
  failures === 0
    ? "\nALL CHECKS PASSED — bridge path works end to end against a real device"
    : `\n${failures} CHECK(S) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
