// 验收「嵌入模式」（?embed=1，见 src/embed.ts）。
//
// 为什么值得单独一个脚本：这条路径**只在被别人 iframe 起来时才存在**，手工点开
// 页面永远走不到 —— 它的两个失败方式（消息没发出去、origin 校验把自己人也挡了）
// 都不会在页面上留下任何痕迹，只是配置台那边永远等不到设备状态。
//
// 这里不碰真设备：WebUSB 要插着手机才有意义，那部分靠人工。能自动化验的是协议本身。
//   * 嵌进去之后会主动 post `adbstudio:ready`
//   * ping 能拿到 `adbstudio:state`
//   * 白名单外的 origin 发消息**不被回应**
//   * 顶栏在嵌入模式下只剩状态 + 齿轮（页签是别人界面里的干扰；但齿轮**必须留**——
//     「本机桥接」是在那个面板里配的，而 http 上级页面下桥接是唯一可走的路）
//
//   node scripts/verify-embed.mjs [dist 目录]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIST = resolve(process.argv[2] ?? "dist");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// 父页面：127.0.0.1 在 embed.ts 的白名单里（本机开发用的那一条）。
const PARENT = `<!doctype html><meta charset="utf-8"><title>parent</title>
<iframe id="f" src="/?embed=1" allow="usb" style="width:900px;height:700px"></iframe>
<script>
  window.__msgs = [];
  addEventListener("message", (e) => window.__msgs.push({ origin: e.origin, data: e.data }));
  window.__ping = () => document.getElementById("f").contentWindow.postMessage(
    { type: "adbstudio:ping" }, "*");
</script>`;

const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (path === "/parent.html") {
    res.writeHead(200, { "Content-Type": TYPES[".html"] });
    return res.end(PARENT);
  }
  const file = path === "/" ? "/index.html" : path;
  try {
    const body = await readFile(join(DIST, file));
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/parent.html`, { waitUntil: "networkidle0" });

// ready 是 iframe 自己发的，等它一会儿（bundle 要先跑起来）
await page
  .waitForFunction(() => window.__msgs.some((m) => m.data?.type === "adbstudio:ready"), { timeout: 15000 })
  .catch(() => undefined);
const msgs = await page.evaluate(() => window.__msgs);
check("嵌入后主动上报 ready", msgs.some((m) => m.data?.type === "adbstudio:ready"),
  JSON.stringify(msgs.map((m) => m.data?.type)));

await page.evaluate(() => window.__ping());
await page
  .waitForFunction(() => window.__msgs.some((m) => m.data?.type === "adbstudio:state"), { timeout: 5000 })
  .catch(() => undefined);
check("ping 能拿到 state",
  (await page.evaluate(() => window.__msgs)).some((m) => m.data?.type === "adbstudio:state"));

// 白名单之外的来源：这里用 targetOrigin 指向一个别的 origin 发不出去，
// 所以换个角度验 —— iframe 回给父页面的消息，targetOrigin 必须是父页面这个 origin，
// 不能是 "*"（否则任何嵌它的站点都能收到设备信息）。
const looseOrigin = msgs.some((m) => m.origin && m.origin !== `http://127.0.0.1:${port}`);
check("回消息只发给可信上级", !looseOrigin);

const topbar = await page.evaluate(() => {
  const doc = document.getElementById("f").contentDocument;
  return {
    app: !!doc?.querySelector(".app.embed"),
    tabs: !!doc?.querySelector(".topbar .tabs"),
    gear: !!doc?.querySelector(".topbar.embed-bar button[title*='桥接']"),
  };
});
check("嵌入模式打上 .embed", topbar.app);
check("嵌入模式收起页签", !topbar.tabs);
check("嵌入模式留着齿轮（桥接入口）", topbar.gear);

await browser.close();
server.close();
process.exit(failures ? 1 : 0);
