// Verifies a *static-only* deployment: the page served over HTTPS with no
// backend reachable.
//
// This is the shape that matters for remote use — the page's whole job there is
// to talk to a USB device from the browser, which needs a secure context and
// nothing else. What's checked:
//   * the bundle loads and mounts
//   * the page is a secure context, so navigator.usb exists (WebUSB requires it)
//   * a missing backend degrades gracefully instead of erroring: the
//     backend-only panels are disabled and the self-check says why
//   * no console errors / unhandled rejections
//
//   npm run verify:static https://adb.example.com [screenshotDir]

import { mkdirSync } from "node:fs";

import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.argv[2];
const SHOTS = process.argv[3] ?? ".";

if (!BASE) {
  console.error("usage: verify-static.mjs <baseUrl> [screenshotDir]");
  process.exit(2);
}
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
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => pageErrors.push(String(e)));

const failedRequests = [];
let apiFailures = 0;
page.on("response", (r) => {
  if (r.status() < 400) return;
  // /api/* is expected to fail here (no backend); anything else 4xx/5xx is a
  // deploy problem — a missing asset or a bad path.
  if (r.url().includes("/api/")) apiFailures += 1;
  else failedRequests.push(`${r.status()} ${r.url()}`);
});

const text = () => page.evaluate(() => document.body.innerText);
const clickByText = async (sel, want) => {
  const h = await page.evaluateHandle(
    (s, w) => [...document.querySelectorAll(s)].find((n) => n.textContent.includes(w)) ?? null,
    sel,
    want
  );
  const el = h.asElement();
  if (!el) throw new Error(`no ${sel} with "${want}"`);
  await el.click();
};

await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });

check("page loads and mounts", (await text()).includes("ADB Studio"));
check("all non-API assets served", failedRequests.length === 0, failedRequests.slice(0, 3).join(" | "));

// The reason this has to be HTTPS at all.
const ctx = await page.evaluate(() => ({
  secure: window.isSecureContext,
  usb: !!navigator.usb,
  webcodecs: typeof VideoDecoder !== "undefined",
}));
check("secure context (required by WebUSB)", ctx.secure, BASE);
check("navigator.usb available", ctx.usb);
check("WebCodecs available (mirroring)", ctx.webcodecs);

// With no backend, the app must still be usable for USB work.
const body = await text();
check(
  "empty state invites connecting a device",
  body.includes("连接一台设备"),
  body.match(/连接一台设备/)?.[0] ?? ""
);
const buttons = await page.evaluate(() =>
  [...document.querySelectorAll("button")].map((b) => ({
    label: b.textContent.trim(),
    disabled: b.disabled,
  }))
);
const serverFiles = buttons.find((b) => b.label === "Server Files");
const dino = buttons.find((b) => b.label === "Dino Admin");
const connectUsb = buttons.find((b) => b.label.includes("连接 USB 设备"));
// 这两个入口现在对匿名访客**根本不渲染**（只在识别出公司身份后出现），而不是渲染出来
// 再置灰 —— 所以正确的断言是"找不到"。上一版断言的是 disabled===true，在访问模型改成
// 「ADB 公开、内网功能需登录」之后就一直是假失败。
check(
  "backend-only entries hidden from anonymous visitors",
  serverFiles === undefined && dino === undefined,
  `Server Files=${serverFiles ? "可见" : "隐藏"}, Dino=${dino ? "可见" : "隐藏"}`
);
// 「登录解锁」要等身份探测（跨源打 /api/auth/whoami）回来才渲染，networkidle2 之后
// 立刻取快照会漏掉它 —— 所以这里等，而不是断言当下那一帧。
const signInAppeared = await page
  .waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("登录解锁")),
    { timeout: 15000, polling: 300 }
  )
  .then(() => true)
  .catch(() => false);
check("sign-in is offered instead", signInAppeared);
check("USB connect stays enabled", connectUsb !== undefined && connectUsb.disabled === false);

await page.screenshot({ path: `${SHOTS}/static-01-empty.png` });

// The self-check panel should explain the missing backend rather than look broken.
await clickByText("button", "连接方式");
await page.waitForFunction(() => document.body.innerText.includes("方式一"), {
  timeout: 20000,
  polling: 300,
});
const help = await text();
// 页面在 Cloudflare Pages、API 在另一个 hostname 经 tunnel 出，公开的 /api/health
// 跨源可达 —— 所以自检面板应当报告后端**可用**。
// 上一版断言的是"无法连接后端"，那是"公网静态页碰不到内网后端"时代的预期；
// 现在拆分完成后它会因为一切正常而失败。
check(
  "self-check reports the backend as reachable",
  !help.includes("无法连接后端") && !help.includes("令牌无效"),
  help.includes("无法连接后端") ? "仍报告不可达（CORS 或 ALLOWED_ORIGINS 配错？）" : "后端可达"
);
check("self-check confirms secure context", help.includes("安全上下文"));
await page.screenshot({ path: `${SHOTS}/static-02-help.png` });

check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

// Chrome's "Failed to load resource" console line carries no URL, so it can't be
// attributed by string matching. Drop those and rely on the request-level
// assertion above, which already fails on any non-API 4xx/5xx.
const loadFailures = consoleErrors.filter((e) => e.includes("Failed to load resource"));
// 匿名访客探测 /api/auth/whoami 时，Cloudflare Access 会把它 302 到登录门户，而那个
// 跨源响应没有 CORS 头 —— 浏览器必然报一条错。这正是代码里判断"未登录"的方式
// （见 api/index.ts 的 identity()），是结构性的，不是缺陷。
const accessProbe = (e) =>
  e.includes("cloudflareaccess.com") || e.includes("/cdn-cgi/access/login");
const meaningful = consoleErrors.filter(
  (e) => !e.includes("favicon") && !e.includes("Failed to load resource") && !accessProbe(e)
);
check("no unexpected console errors", meaningful.length === 0, meaningful.slice(0, 2).join(" | "));
check(
  "resource load failures are only the expected /api probes",
  loadFailures.length <= apiFailures + consoleErrors.filter(accessProbe).length,
  `${loadFailures.length} console load errors vs ${apiFailures} API failures + ${consoleErrors.filter(accessProbe).length} Access probes`
);

await browser.close();
console.log(
  failures === 0
    ? "\nSTATIC DEPLOYMENT OK — 页面全部来自 Cloudflare Pages，公开 API 跨源可达"
    : `\n${failures} CHECK(S) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
