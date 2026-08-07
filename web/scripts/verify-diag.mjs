// 诊断上传：端点 + 页面按钮 + 配额淘汰 + 限流，一起在本地跑一遍。
//
//   npm run build && npm run verify:diag
//
// 自带 `wrangler pages dev`（本地 D1，不碰线上库）和 Chrome，跑完自己收摊。
//
// 为什么这几条一定要有自动化：
//
//   * 淘汰只在库写满时发生，真实数据量下测不到 —— 所以配额可以用 DIAG_BUDGET_BYTES /
//     DIAG_MAX_ROWS 调小，这里把它调成 3 行。
//   * 限流第一版是数 reports 表里同来源最近一分钟的行数，而淘汰会把这张表删空 ——
//     洪水攻击下计数永远到不了阈值。这条断言就是为了防止它再回到那个样子。
//   * 上传按钮第一版用 zustand 选择器返回新对象，触发无限渲染（React #185）把整个页面
//     搞崩。所以这里必须真的用浏览器点一次，而不是只 curl 端点。

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8789;
const TOKEN = "verify-diag-token-000000000000";
const ROOT = new URL("..", import.meta.url).pathname;

let fail = 0;
const check = (l, ok, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

// 本地 Function 的环境变量。配额调到 3 行，才能在几次请求里走到淘汰。
writeFileSync(
  join(ROOT, ".dev.vars"),
  `DIAG_TOKEN=${TOKEN}\nDIAG_SALT=verify-salt\nDIAG_MAX_ROWS=3\n`,
);

const server = spawn(
  "npx",
  ["--yes", "wrangler@latest", "pages", "dev", "--port", String(PORT), "--ip", "127.0.0.1"],
  { cwd: ROOT, stdio: "pipe" },
);
const stop = () => {
  try {
    server.kill("SIGTERM");
  } catch {}
};
process.on("exit", stop);

for (let i = 0; ; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`);
    if (r.ok) break;
  } catch {
    if (i > 120) throw new Error("wrangler pages dev 起不来（先 npm run build）");
    await new Promise((r) => setTimeout(r, 500));
  }
}

const api = (path) => `http://127.0.0.1:${PORT}/diag${path}`;
const post = (body) =>
  fetch(api(""), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const report = (note) => ({
  version: "index-VERIFY.js",
  note,
  env: { ua: "verify", platform: "macOS", webusb: true },
  usb: [{ vendorId: 1, productId: 2, serial: "SERIAL-A", opened: false, configured: true }],
  state: { devices: [{ serial: "SERIAL-A", source: "webusb", state: "offline" }] },
  previous: [],
  events: [
    { t: 1, kind: "usb", msg: "claiming interface" },
    { t: 2, kind: "usb", msg: "claim failed", data: { busy: true } },
  ],
});

// --- 端点本身 -------------------------------------------------------------

{
  const res = await post(report("第一条"));
  const body = await res.json();
  check("上传成功并返回短编号", res.status === 200 && /^[a-z0-9]+-[a-z0-9]+$/.test(body.id), body.id);

  const listed = await fetch(api(`?token=${TOKEN}`));
  const list = await listed.json();
  const row = list.reports.find((r) => r.id === body.id);
  check("列表里能查到", !!row);
  // 摘要取最后一次失败，列表里就能分类，不用打开正文。
  check("摘要提取到失败事件", row?.summary === "usb: claim failed", row?.summary);
  check("序列号已索引", row?.serials === "SERIAL-A", row?.serials);

  const one = await (await fetch(api(`/${body.id}?token=${TOKEN}`))).json();
  check("正文原样存下来", one.payload?.env?.platform === "macOS" && one.payload.events.length === 2);
}

// --- 查看侧必须要 token ---------------------------------------------------

check("列表无 token 401", (await fetch(api(""))).status === 401);
check("详情无 token 401", (await fetch(api("/whatever"))).status === 401);
check("错 token 401", (await fetch(api("?token=wrong"))).status === 401);
check("不是 JSON → 400", (await fetch(api(""), { method: "POST", body: "not json" })).status === 400);

// --- 配额淘汰（DIAG_MAX_ROWS=3）-------------------------------------------

{
  for (let i = 2; i <= 5; i++) await post(report(`第 ${i} 条`));
  const list = await (await fetch(api(`?token=${TOKEN}`))).json();
  check("超配额后只剩最新 3 条", list.reports.length === 3, `${list.reports.length} 条`);
  check(
    "删的是最旧的（留下的是最后三条）",
    list.reports.map((r) => r.note).join(",") === "第 5 条,第 4 条,第 3 条",
    list.reports.map((r) => r.note).join(","),
  );

  const stats = await (await fetch(api(`/stats?token=${TOKEN}`))).json();
  check("stats 报出用量与配额", stats.rows === 3 && stats.maxRows === 3 && stats.budgetBytes > 0);
}

// --- 限流（6/分钟），且必须不受淘汰影响 -----------------------------------

{
  // 上面已经发了 5 条；再发到超过阈值。淘汰同时在把 reports 压到 3 行 —— 计数如果
  // 还依赖那张表，这里就会全部 200。
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await post(report("洪水"))).status);
  check("超过每分钟上限后返回 429", codes.includes(429), codes.join(","));
  check("淘汰不会把限流计数一起删掉", codes.filter((c) => c === 429).length >= 2, codes.join(","));
}

// --- 页面上的按钮 ---------------------------------------------------------

{
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle2" });

  // 造出「设备在列表里但被占用」这个状态 —— 上传入口就在那一页上。
  await page.evaluate(() => {
    window.__adbstudio.store.setState({
      active: null,
      tab: "device",
      blocked: { serial: "C414TEST", name: "DN_ENG41" },
      devices: [
        {
          id: "webusb:C414TEST",
          serial: "C414TEST",
          name: "DN_ENG41",
          model: "DN_ENG41",
          state: "offline",
          connection: "usb",
          source: "webusb",
        },
      ],
    });
  });
  await page.waitForFunction(() => /被本机的 adb 占着/.test(document.body.innerText), {
    timeout: 5000,
  });
  check("占用页给出两条出路和重试", /adb kill-server/.test(await page.evaluate(() => document.body.innerText)));
  check("渲染没有抛错（无限渲染会在这里现形）", errors.length === 0, errors.join(" | "));

  // 限流窗口还没过，所以这次上传预期被拒 —— 但要的是"按钮把失败说出来"，
  // 而不是静默失败。
  await page.type('input[placeholder^="出了什么问题"]', "端到端验证");
  await page.evaluate(() =>
    [...document.querySelectorAll("button")].find((b) => b.textContent.includes("上传诊断日志")).click(),
  );
  await page.waitForFunction(
    () => /已上传，编号|太频繁|上传失败/.test(document.body.innerText),
    { timeout: 20000 },
  );
  const shown = await page.evaluate(() => document.body.innerText);
  check("点按钮后有明确结果（成功编号或被限流的原因）", /已上传，编号|太频繁|上传失败/.test(shown));
  await browser.close();
}

stop();
console.log(fail ? `\n${fail} FAILED` : "\nDIAG OK");
process.exit(fail ? 1 : 0);
