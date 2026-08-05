// Can a page served from the public internet talk to a device through a bridge
// running on the user's own machine, while an adb server holds that device?
//
// This is the whole point of bridge mode — it is what lets the web app coexist
// with Android Studio — and it crosses a boundary Chrome polices: the Local
// Network Access check blocks an internet page from reaching 127.0.0.1 unless
// the user allows it. So the test must run in a REAL browser window; headless
// Chrome denies the permission with no prompt and this would always fail.
//
//   ./scripts/bridge.sh            # in another terminal
//   node scripts/verify-local-bridge.mjs
//
// It stands in https://example.com for the hosted app: same thing that matters
// here, a public https origin, and it needs no login. The bytes on the wire are
// the adb *server* protocol, the same one Tango's AdbServerClient speaks.
import puppeteer from "puppeteer-core";

const BRIDGE = process.argv[2] ?? "ws://127.0.0.1:7070/api/adb";
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: false, // required: see above
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });

const result = await page.evaluate(async (bridge) => {
  const out = {};
  out.origin = window.location.origin;
  out.permissionBefore = (
    await navigator.permissions.query({ name: "local-network-access" })
  ).state;

  const ws = new WebSocket(bridge);
  ws.binaryType = "arraybuffer";

  out.open = await new Promise((resolve) => {
    const t = setTimeout(() => resolve("TIMEOUT"), 8000);
    ws.onopen = () => { clearTimeout(t); resolve("OPEN"); };
    ws.onerror = () => { clearTimeout(t); resolve("BLOCKED"); };
  });
  if (out.open !== "OPEN") return out;

  // adb server protocol: every request is a 4-digit hex length followed by the
  // command; the reply is "OKAY" then a length-prefixed payload.
  const chunks = [];
  ws.onmessage = (e) => chunks.push(new Uint8Array(e.data));
  const request = (cmd) => {
    const body = new TextEncoder().encode(cmd);
    const head = new TextEncoder().encode(
      body.length.toString(16).padStart(4, "0")
    );
    ws.send(new Uint8Array([...head, ...body]));
  };
  const collect = async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    return new TextDecoder().decode(all);
  };

  request("host:version");
  out.version = await collect(1200);

  chunks.length = 0;
  const ws2 = new WebSocket(bridge);
  ws2.binaryType = "arraybuffer";
  await new Promise((r) => { ws2.onopen = r; ws2.onerror = r; });
  ws2.onmessage = (e) => chunks.push(new Uint8Array(e.data));
  const body = new TextEncoder().encode("host:devices");
  const head = new TextEncoder().encode("000c");
  ws2.send(new Uint8Array([...head, ...body]));
  out.devices = await collect(1500);

  ws.close();
  ws2.close();
  out.permissionAfter = (
    await navigator.permissions.query({ name: "local-network-access" })
  ).state;
  return out;
}, BRIDGE);

console.log(`\norigin: ${result.origin}  (a public https page, standing in for the hosted app)`);
console.log(`local-network-access permission: ${result.permissionBefore} -> ${result.permissionAfter ?? "n/a"}`);
console.log(`raw host:devices reply: ${JSON.stringify(result.devices ?? "")}\n`);

check("websocket to the local bridge opens", result.open === "OPEN", result.open);
check(
  "adb server answers host:version",
  /^OKAY[0-9a-f]{4}[0-9a-f]+/.test(result.version ?? ""),
  (result.version ?? "").slice(0, 20)
);

// The device must be listed as `device`, not `offline` or `unauthorized` — those
// mean the bridge reached adb but adb cannot actually drive the phone.
const serials = [...(result.devices ?? "").matchAll(/([A-Za-z0-9._:-]+)\t(device|offline|unauthorized)/g)];
check(
  "a ready device is visible through the bridge",
  serials.some((m) => m[2] === "device"),
  serials.map((m) => `${m[1]}=${m[2]}`).join(", ") || "none"
);

await browser.close();

// The point of all this: adb still owns the device afterwards. If the bridge had
// stolen the USB interface the way WebUSB does, this would now fail.
const { execSync } = await import("node:child_process");
const after = execSync("adb devices").toString();
check(
  "the local adb server still has the device (nothing was killed)",
  /\tdevice\b/.test(after),
  after.split("\n").filter((l) => l.includes("\t")).join(" ")
);

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nLOCAL BRIDGE OK — shared with adb / Android Studio");
process.exit(fail ? 1 : 0);
