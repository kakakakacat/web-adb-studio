// Drives the real built page in headless Chrome against a real device, using the
// bridge transport (which needs no user gesture, unlike WebUSB).
//
// Verifies what only a browser can: that the components mount, that the store
// wiring works, and that every panel renders real data from the device and the
// backend. Read-only — nothing here installs, uninstalls, reboots or writes.
//
//   npm run build                     # the page under test is dist/
//   cd ../server && cargo run         # with ADBSTUDIO_STATIC=../web/dist
//   adb start-server                  # the bridge needs a real adb server
//   npm run verify:ui [baseUrl] [screenshotDir]
//
// NOT covered, because it cannot be automated: the WebUSB path. Its chooser is
// native browser UI that CDP's DeviceAccess domain does not surface here, and
// more fundamentally Tango authenticates with its own RSA key, so the *phone*
// shows "Allow USB debugging?" and someone has to tap it.

import { mkdirSync } from "node:fs";

import puppeteer from "puppeteer-core";

// Override with CHROME_PATH when not on a default macOS install.
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// A token-protected backend can be reached by passing the credentials in the
// hash, e.g. "http://host:7070/#token=…" — the app adopts and scrubs it.
const BASE = process.argv[2] ?? "http://127.0.0.1:7070";
const SHOTS = process.argv[3] ?? ".";

mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const consoleErrors = [];
const pageErrors = [];

function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--window-size=1440,900",
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => pageErrors.push(String(e)));

const text = () => page.evaluate(() => document.body.innerText);

async function clickByText(selector, needle) {
  const handle = await page.evaluateHandle(
    (sel, want) => {
      const nodes = [...document.querySelectorAll(sel)];
      return nodes.find((n) => n.textContent.includes(want)) ?? null;
    },
    selector,
    needle
  );
  const el = handle.asElement();
  if (!el) throw new Error(`no ${selector} containing "${needle}"`);
  await el.click();
  return el;
}

const waitForText = (needle, timeout = 30000) =>
  page.waitForFunction(
    (want) => document.body.innerText.includes(want),
    { timeout, polling: 300 },
    needle
  );

// --- load ----------------------------------------------------------------

await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
check("page loads and React mounts", (await text()).includes("ADB Studio"));

// Whatever device the adb server has; the store enumerates it without any user
// gesture because the bridge is same-origin here.
await page
  .waitForFunction(() => document.querySelectorAll("button.device").length > 0, {
    timeout: 30000,
    polling: 300,
  })
  .catch(() => {});
const device = await page.evaluate(() => {
  const b = document.querySelector("button.device");
  return b
    ? { name: b.querySelector(".name")?.textContent, serial: b.querySelector(".sub")?.textContent }
    : null;
});
check(
  "device from bridge appears in sidebar",
  device !== null,
  device ? `${device.name} (${device.serial})` : "no device — is one attached?"
);
if (!device) {
  console.log("\nNo device in the list; the rest of the checks need one.");
  await browser.close();
  process.exit(1);
}
await page.screenshot({ path: `${SHOTS}/01-initial.png` });

// --- environment self-check panel ---------------------------------------

// Icon-only button in the topbar — no text to match on, so use its title.
await page.click('button[title*="连接方式"]');
await waitForText("方式一");
const helpText = await text();
check("help panel renders self-checks", helpText.includes("安全上下文"));
check(
  "backend detected as healthy",
  helpText.includes("adb server 127.0.0.1:5037"),
  helpText.match(/v2\.0\.0[^\n]*/)?.[0] ?? ""
);
const usbOk = await page.evaluate(() => window.isSecureContext && !!navigator.usb);
check("WebUSB present (localhost is a secure context)", usbOk);
await page.screenshot({ path: `${SHOTS}/02-help.png` });
await clickByText("button", "关闭");

// --- connect the device --------------------------------------------------

await page.click("button.device");
// "序列号" comes from the device object and renders immediately; the getprop
// fields arrive a second or two later, so wait for one of *those*.
// Case-insensitive on purpose: innerText reflects CSS `text-transform`, and the
// stat labels are uppercased in the stylesheet, so "Android" reads as "ANDROID".
// The label and value are also separated by a newline.
await page.waitForFunction(() => /ANDROID\s+\d/i.test(document.body.innerText), {
  timeout: 60000,
  polling: 500,
});
const overview = await text();
check(
  "device page shows OS info",
  /ANDROID\s+\d+\s*\(\d+\)/i.test(overview),
  overview.match(/ANDROID\s+\S+[^\n]*/i)?.[0]?.replace(/\s+/g, " ") ?? ""
);
check("connection labelled as bridge", overview.includes("adb 桥接"));
// Build type is read on the same page now (root/remount are gated on it).
await page.waitForFunction(
  () => /构建/.test(document.body.innerText),
  { timeout: 30000, polling: 500 }
).catch(() => {});
check(
  "build type read (gates root/remount)",
  /userdebug|eng|user/.test(await text()),
  (await text()).match(/构建\s*\n\s*(\S+)/)?.[1] ?? "(not shown)"
);
await page.screenshot({ path: `${SHOTS}/03-device.png` });

// --- screenshot capture (real device framebuffer) -----------------------

await clickByText("button", "预览");
await page.waitForFunction(
  () => {
    const img = [...document.querySelectorAll("img")].find(
      (i) => i.getAttribute("alt") === "设备截图"
    );
    return img && img.naturalWidth > 0;
  },
  { timeout: 40000, polling: 500 }
);
const shotDims = await page.evaluate(() => {
  const img = [...document.querySelectorAll("img")].find(
    (i) => i.getAttribute("alt") === "设备截图"
  );
  return img ? `${img.naturalWidth}x${img.naturalHeight}` : "none";
});
check("device screenshot decodes in the page", shotDims !== "none", shotDims);
await page.screenshot({ path: `${SHOTS}/04-screenshot.png` });

// --- apps ----------------------------------------------------------------

await clickByText("button.tab", "应用");
// The count line renders during loading too, so wait for the spinner text to go
// away rather than for the count to merely exist.
await page.waitForFunction(
  () => {
    const t = document.body.innerText;
    return /\d+ 个应用/.test(t) && !t.includes("读取中…");
  },
  { timeout: 90000, polling: 500 }
);
const appsText = await text();
const appCount = appsText.match(/(\d+) 个应用/)?.[1];
check("app list loads from device", Number(appCount) > 0, `${appCount} packages`);

// Icons load a few at a time, one adb round-trip each; on a device without the
// helper the first batch also waits for it to be installed.
//
// Assert on *every* icon, not just one. "At least one decoded" is what let a real
// bug through: while the helper was installing, sibling requests gave up and
// cached a null icon, so only the request that triggered the install ever showed
// an icon. That looked fine to a `some()` check.
const iconStat = await (async () => {
  let prev = "";
  for (let i = 0; i < 60; i += 1) {
    const snap = await page.evaluate(() => {
      const rows = document.querySelectorAll(".app-card").length;
      const imgs = [...document.querySelectorAll(".app-card img.icon")];
      return {
        rows,
        imgs: imgs.length,
        decoded: imgs.filter((x) => x.naturalWidth > 0).length,
      };
    });
    const key = `${snap.rows}:${snap.imgs}:${snap.decoded}`;
    // Settled: two identical samples in a row, with something actually loaded.
    if (key === prev && snap.imgs > 0) return snap;
    prev = key;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return page.evaluate(() => {
    const imgs = [...document.querySelectorAll(".app-card img.icon")];
    return {
      rows: document.querySelectorAll(".app-card").length,
      imgs: imgs.length,
      decoded: imgs.filter((x) => x.naturalWidth > 0).length,
    };
  });
})();

check(
  "every rendered app icon decodes",
  iconStat.imgs > 0 && iconStat.decoded === iconStat.imgs,
  `${iconStat.decoded}/${iconStat.imgs} decoded (${iconStat.rows} rows)`
);
// A package with no icon renders a placeholder div instead of an <img>, so a big
// shortfall means icon lookups are failing rather than genuinely having none.
check(
  "most packages resolved an icon",
  iconStat.imgs >= Math.max(1, iconStat.rows - 1),
  `${iconStat.imgs} icons for ${iconStat.rows} packages`
);

const firstPkg = await page.evaluate(() => {
  const card = document.querySelector(".app-card");
  return card?.getAttribute("title") ?? null;
});
if (firstPkg) {
  await page.click(".app-card");
  await waitForText("版本", 30000);
  const detail = await text();
  check("app detail renders (dumpsys parsed)", detail.includes("类型"), firstPkg);
}
await page.screenshot({ path: `${SHOTS}/05-apps.png` });

// --- files ---------------------------------------------------------------

await clickByText("button.tab", "文件");
await waitForText("设备文件", 30000);
await page.waitForFunction(() => !document.body.innerText.includes("读取中…"), {
  timeout: 40000,
  polling: 500,
});
const filesText = await text();
check(
  "device directory listing renders",
  filesText.includes("设备文件") && !filesText.includes("读取中…"),
  filesText.includes("空目录") ? "empty dir (valid)" : "entries listed"
);
await page.screenshot({ path: `${SHOTS}/06-files.png` });


// --- mirroring (scrcpy + WebCodecs in-page) -----------------------------

await clickByText("button.tab", "投屏");
await waitForText("开始投屏", 20000);
await clickByText("button", "开始投屏");

let mirrorOk = false;
let mirrorDetail = "";
try {
  // An untouched <canvas> is 300x150, which `width > 0` would happily accept —
  // that false pass hid a real failure once. Require a real decoded size, and
  // bail out early if the panel reported an error instead.
  await page.waitForFunction(
    () => {
      if (document.body.innerText.includes("投屏启动失败")) {
        throw new Error("mirror start failed");
      }
      const c = document.querySelector(".screen canvas");
      if (!c) return false;
      const isDefault = c.width === 300 && c.height === 150;
      return !isDefault && c.width >= 240 && c.height >= 240;
    },
    { timeout: 90000, polling: 1000 }
  );
  mirrorDetail = await page.evaluate(() => {
    const c = document.querySelector(".screen canvas");
    return `${c.width}x${c.height}`;
  });
  mirrorOk = true;
} catch {
  mirrorDetail = (await text()).match(/投屏[^\n]*/)?.[0] ?? "no canvas size";
}
check("scrcpy stream reaches the canvas", mirrorOk, mirrorDetail);
await page.screenshot({ path: `${SHOTS}/08-mirror.png` });

if (mirrorOk) {
  const painted = await page.evaluate(() => {
    const c = document.querySelector(".screen canvas");
    const off = document.createElement("canvas");
    off.width = 40;
    off.height = 40;
    const ctx = off.getContext("2d");
    try {
      ctx.drawImage(c, 0, 0, 40, 40);
      const data = ctx.getImageData(0, 0, 40, 40).data;
      let nonBlack = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) nonBlack += 1;
      }
      return nonBlack;
    } catch (e) {
      return `error: ${e.message}`;
    }
  });
  check(
    "decoded frames contain image data",
    typeof painted === "number" && painted > 0,
    typeof painted === "number" ? `${painted}/1600 non-black px` : String(painted)
  );
}

await clickByText("button", "停止").catch(() => {});

// --- Server Files (backend SFTP, real NAS) ------------------------------

await clickByText("button", "Server Files");
await page.waitForFunction(
  () => !document.body.innerText.includes("正在读取服务端配置"),
  { timeout: 40000, polling: 500 }
);
await page
  .waitForFunction(() => !document.body.innerText.includes("读取中…"), {
    timeout: 60000,
    polling: 500,
  })
  .catch(() => {});
const sfText = await text();
// Assert on listed directories, not on a connection string in the header — that
// header is gone, and the directories are what actually prove the backend read
// the share.
check(
  "Server Files lists the NAS",
  /GigglePal|ClawGo/.test(sfText) && !sfText.includes("读取中…"),
  sfText.match(/GigglePal|ClawGo/)?.[0] ?? "no known dir seen"
);
await page.screenshot({ path: `${SHOTS}/09-serverfiles.png` });
await clickByText("button", "关闭");

// --- Dino Admin (render only; every action is a write) ------------------

await clickByText("button", "Dino Admin");
await waitForText("创建设备账号", 20000);
const dinoText = await text();
check("Dino Admin renders three-step flow", dinoText.includes("充值金币"));
await clickByText("button", "查看派生密码");
await waitForText("密码：", 20000);
const pwText = await text();
check(
  "password derivation via backend",
  /密码：[0-9a-f]{32}/.test(pwText),
  pwText.match(/密码：[0-9a-f]{8}/)?.[0] ?? ""
);
await page.screenshot({ path: `${SHOTS}/10-dino.png` });
await clickByText("button", "关闭");

// --- error hygiene -------------------------------------------------------

check(
  "no uncaught page errors",
  pageErrors.length === 0,
  pageErrors.slice(0, 3).join(" | ")
);
const meaningful = consoleErrors.filter(
  (e) =>
    !e.includes("favicon") &&
    !e.includes("Failed to load resource: the server responded with a status of 404")
);
check("no console errors", meaningful.length === 0, meaningful.slice(0, 3).join(" | "));

await browser.close();

console.log(
  failures === 0
    ? "\nALL UI CHECKS PASSED (headless Chrome, real device via bridge)"
    : `\n${failures} UI CHECK(S) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
