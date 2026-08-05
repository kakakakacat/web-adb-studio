// The two situations a machine can be in, and the promise that the page handles
// both without being told which:
//
//   no adb server running  -> WebUSB claims the device directly. Nothing is
//                             installed on that machine; this is the "open the
//                             site and it works" path.
//   adb server holding it  -> WebUSB gets DeviceBusyError, and the page switches
//                             itself to a bridge to that same adb server.
//
// Runs headed: the WebUSB chooser and Chrome's local-network permission both
// behave differently under headless (the latter is auto-denied), so a headless
// pass here would prove nothing about a real browser.
//
//   node scripts/verify-transport-auto.mjs [url]
//
// Needs a device on USB and `adb` on PATH. Leaves the adb server running.
import { execSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const URL_ = process.argv[2] ?? "http://127.0.0.1:7070";
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const adb = (args) => {
  try {
    return execSync(`adb ${args} 2>&1`).toString();
  } catch (e) {
    return String(e.stdout ?? e);
  }
};

async function run({ label, adbRunning, expect }) {
  console.log(`\n=== ${label} ===`);
  if (adbRunning) adb("start-server");
  else adb("kill-server");
  console.log(`    adb server running: ${adbRunning}`);

  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: false,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  // A fresh profile each run, so a bridge override left by the previous case
  // can't make the next one pass for the wrong reason.
  await page.goto(URL_, { waitUntil: "networkidle2" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle2" });

  const connect = await page.evaluateHandle(() =>
    [...document.querySelectorAll("button")].find((b) => b.textContent.includes("连接 USB 设备"))
  );
  if (!connect.asElement()) {
    check(`${label}: connect button present`, false);
    await browser.close();
    return;
  }

  // The device chooser is browser UI, not page content — drive it over CDP.
  const [prompt] = await Promise.all([
    page.waitForDevicePrompt({ timeout: 20000 }).catch(() => null),
    connect.asElement().click(),
  ]);
  if (prompt) {
    const device = prompt.devices[0];
    console.log(`    chooser offered: ${prompt.devices.map((d) => d.name).join(", ") || "(none)"}`);
    if (device) await prompt.select(device).catch(() => {});
  } else {
    console.log("    (no chooser appeared)");
  }

  // Either outcome resolves to a connected device; only the route differs.
  const connected = await page
    .waitForFunction(() => /ANDROID\s+\d|SDK\s+\d/i.test(document.body.innerText), {
      timeout: 60000,
      polling: 500,
    })
    .then(() => true)
    .catch(() => false);

  const state = await page.evaluate(() => ({
    bridge: localStorage.getItem("adbstudio.bridgeUrl"),
    text: document.body.innerText,
  }));

  check(`${label}: device connected`, connected);
  if (expect === "webusb") {
    check(
      `${label}: stayed on WebUSB (no bridge needed)`,
      state.bridge === null,
      `bridgeUrl=${state.bridge}`
    );
  } else {
    check(
      `${label}: switched itself to the local bridge`,
      state.bridge === "ws://127.0.0.1:7070/api/adb",
      `bridgeUrl=${state.bridge}`
    );
    check(
      `${label}: told the user what happened`,
      /自动改用本机桥接|已切换到本机桥接/.test(state.text)
    );
    check(
      `${label}: adb still owns the device (Android Studio unaffected)`,
      /\tdevice\b/.test(adb("devices"))
    );
  }
  await browser.close();
}

// Order matters: the busy case must run second, or `adb kill-server` in the
// first case would tear down the bridge the second one depends on.
await run({ label: "no adb server", adbRunning: false, expect: "webusb" });
await run({ label: "adb server holding the device", adbRunning: true, expect: "bridge" });

adb("start-server");
console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nTRANSPORT AUTO-SELECTION OK");
process.exit(fail ? 1 : 0);
