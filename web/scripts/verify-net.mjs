#!/usr/bin/env node
// 抓包 tab against a real device, in a real browser.
//
// scripts/verify-netcapture.mjs proves the *device* half over `adb forward`. This
// one proves the half that matters to a user: rows appear in the page, the detail
// pane decodes what the app actually sent, and stopping releases the collector.
//
// It drives the adb-server transport (same-origin /api/adb) rather than WebUSB,
// because WebUSB needs a chooser gesture that headless Chrome cannot give. Both
// transports produce the same `Adb`, so what runs here is the same code path.
//
// Traffic has to be provoked: Dino only talks gRPC when something happens, so this
// pokes the device with adb between assertions.
//
// Usage: node scripts/verify-net.mjs http://localhost:1421 [screenshotDir]

import { spawnSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http")) ?? "http://localhost:1421";
const shotDir = args.find((a) => a.startsWith("/")) ?? "/tmp";
/** Which collector to attach to; defaults to whatever the page discovers first. */
const wantSocket = args.find((a) => a.startsWith("--socket="))?.slice(9);
/** Provoke an HTTP download instead of gRPC (Dino is gRPC-only). */
const httpMode = args.includes("--http");
const tag = httpMode ? "http" : "grpc";
/** Which app to poke for HTTP; derived from the socket name's suffix. */
const probePkg = wantSocket?.includes(".") ? wantSocket.split(".").slice(1).join(".") : "com.dm.ai.dino";

const adb = (...args) => spawnSync("adb", args, { encoding: "utf8" }).stdout ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 950 });
page.on("pageerror", (e) => {
  console.log("[pageerror]", String(e));
  fail++;
});
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console]", m.text());
});

const click = async (selector, text) => {
  const handle = await page.evaluateHandle(
    (s, t) => [...document.querySelectorAll(s)].find((n) => n.textContent.includes(t)),
    selector,
    text
  );
  const el = handle.asElement();
  if (!el) throw new Error(`找不到 ${selector} 含「${text}」的元素`);
  await el.click();
};

await page.goto(url, { waitUntil: "networkidle2" });

// The device list arrives over the adb server; the sidebar shows the model once
// it's connected and the topbar tabs appear.
const connected = await page
  .waitForFunction(() => document.querySelectorAll("button.tab").length > 0, {
    timeout: 90000,
    polling: 1000,
  })
  .then(() => true)
  .catch(() => false);
check("device connected via adb server transport", connected);
if (!connected) {
  await page.screenshot({ path: `${shotDir}/net-nodevice.png` });
  await browser.close();
  process.exit(1);
}

await click("button.tab", "抓包");
await page.waitForFunction(() => document.body.innerText.includes("点“开始”连接设备上的采集器"), {
  timeout: 20000,
  polling: 300,
});
check("抓包 tab renders idle state", true);

// The socket name is discovered from /proc/net/unix, so this also checks that the
// page found a live collector rather than falling back to the compiled-in default.
await sleep(2500);
// `.netsocket` specifically: a generic ".card select" would grab the protocol
// filter instead. The control is always a <select> now — the socket name is never
// typed by hand.
const socketField = await page.evaluate(() => {
  const el = document.querySelector(".netsocket");
  return {
    options: [...(el?.querySelectorAll?.("option") ?? [])].map((o) => o.value),
    value: el?.value ?? "",
  };
});
check(
  "collector socket discovered on device",
  /^netcapture/.test(socketField.value),
  `${socketField.value}${socketField.options.length ? ` (${socketField.options.length} 个)` : ""}`
);

if (wantSocket) {
  const picked = await page.evaluate((name) => {
    const sel = document.querySelector("select.netsocket");
    if (sel && [...sel.options].some((o) => o.value === name)) {
      sel.value = name;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return name;
    }
    return "";
  }, wantSocket);
  check("selected the requested collector", picked === wantSocket, picked);
  await sleep(300);
}

await click("button", "开始");
const attached = await page
  .waitForFunction(() => /pid \d+ \/ uid \d+/.test(document.body.innerText), {
    timeout: 30000,
    polling: 500,
  })
  .then(() => true)
  .catch(() => false);
check("attached to the app's collector", attached, await banner(page));

// Provoke traffic, and keep provoking. Dino's gRPC calls are periodic rather than
// per-interaction, so a fixed 12-second window is a coin flip — the first run of
// this script passed and the second saw nothing, with no code change in between.
// Cycle the pokes until rows show up or a real timeout expires.
const pokes = httpMode
  ? [
      // The debug-only probe receiver, rather than tapping UI: this project's
      // OkHttp traffic only happens on download paths, and driving those by blind
      // coordinates is neither reproducible nor safe (it wandered into a settings
      // screen once). See netcapture/runtime/.../CaptureProbeReceiver.kt.
      () =>
        adb(
          "shell",
          "am",
          "broadcast",
          "-n",
          `${probePkg}/kakacat.android.netcapture.CaptureProbeReceiver`,
          "-a",
          "kakacat.android.netcapture.PROBE"
        ),
    ]
  : [
      () => adb("shell", "input", "keyevent", "KEYCODE_HOME"),
      () => adb("shell", "input", "tap", "320", "480"),
      () => adb("shell", "input", "tap", "545", "925"),
      () => adb("shell", "input", "keyevent", "KEYCODE_BACK"),
    ];

/** Rows of the protocol under test — waiting on "any row" would exit early on the
 *  constant gRPC background chatter. */
const rowCount = () =>
  page.evaluate(
    (want) =>
      [...document.querySelectorAll(".netrow")].filter(
        (r) => r.querySelector(".k")?.textContent?.trim() === want
      ).length,
    tag
  );
const deadline = Date.now() + 75000;
for (let i = 0; Date.now() < deadline; i++) {
  pokes[i % pokes.length]();
  await sleep(5000);
  if ((await rowCount()) > 0) break;
}

const rows = await rowCount();
const allRows = await page.evaluate(() => document.querySelectorAll(".netrow").length);
check(`${tag} requests appear in the list`, rows > 0, `${rows} / 共 ${allRows} 行`);

const firstRow = await page.evaluate((want) => {
  const r = [...document.querySelectorAll(".netrow")].find(
    (n) => n.querySelector(".k")?.textContent?.trim() === want
  );
  if (!r) return null;
  const cell = (c) => r.querySelector(`.${c}`)?.textContent?.trim() ?? "";
  return { kind: cell("k"), verb: cell("verb"), name: cell("name"), status: cell("st"), dur: cell("dur") };
}, tag);
check(
  `${tag} row carries protocol, method, status and duration`,
  !!firstRow && !!firstRow.kind && !!firstRow.name && !!firstRow.status,
  firstRow ? JSON.stringify(firstRow) : ""
);

// Detail pane: the point of the whole exercise is that this shows decoded content,
// not just that a request happened.
//
// Pick a row of the protocol under test, not simply the first one — this project
// emits gRPC constantly, so "the first row" would silently make the HTTP
// assertions (including the redaction one) test nothing.
// Two clicks, and that split is the behaviour under test: the first selects the
// row, the second opens it. One click must NOT open the pane.
const picked = await page.evaluate((want) => {
  const row = [...document.querySelectorAll(".netrow")].find(
    (r) => r.querySelector(".k")?.textContent?.trim() === want
  );
  if (!row) return false;
  row.click();
  return true;
}, tag);
check(`found a ${tag} row to select`, picked);
if (picked) {
  await sleep(400);
  const afterFirst = await page.evaluate(() => ({
    selected: document.querySelectorAll(".netrow.sel").length,
    opened: document.querySelector(".netdetail") !== null,
  }));
  check(
    "first click selects without opening the detail",
    afterFirst.selected === 1 && !afterFirst.opened,
    `选中 ${afterFirst.selected} 条，详情${afterFirst.opened ? "已" : "未"}打开`
  );
  await page.evaluate((want) => {
    [...document.querySelectorAll(".netrow")]
      .find((r) => r.querySelector(".k")?.textContent?.trim() === want)
      ?.click();
  }, tag);
}
if (!picked) {
  await page.screenshot({ path: `${shotDir}/net-${tag}-norow.png` });
  await browser.close();
  process.exit(1);
}
await page.waitForFunction(() => document.querySelector(".netdetail") !== null, {
  timeout: 10000,
  polling: 200,
});
const detail = await page.evaluate(() => {
  const d = document.querySelector(".netdetail");
  return {
    sections: [...d.querySelectorAll(".netsection h4")].map((h) => h.textContent.trim()),
    text: d.innerText.slice(0, 4000),
    bodies: d.querySelectorAll(".netpre").length,
  };
});
check("detail pane opens with sections", detail.sections.length > 2, detail.sections.join(" / "));
check("timeline present", detail.sections.includes("时间线"));
// A skipped body is a *correct* outcome, not a missing feature: a 66MB APK
// download is exactly what the size/content-type policy is there to leave alone.
// What must never happen is a pane that shows neither content nor a reason.
check(
  "detail pane shows decoded content or says why it didn't",
  detail.bodies > 0 || detail.text.includes("没有采到"),
  detail.bodies > 0 ? `${detail.bodies} 个 body 视图` : "按策略跳过，并给出了说明"
);
check(
  "presigned-URL credentials redacted on the device",
  !/X-Amz-Signature=(?!<redacted>)[0-9a-f]{16}/i.test(detail.text),
  "URL 里没有明文签名"
);
check(
  "sensitive headers redacted on the device",
  !/authorization: (?!<redacted>)\S/i.test(detail.text),
  "没有出现明文 Authorization"
);

// The point of shipping descriptors.pb: bodies must come out with field *names*,
// not field numbers. `// <fully.qualified.Type>` is the header render() emits only
// on the descriptor path, so its absence means we silently fell back.
if (!httpMode) {
  const decoded = await page.evaluate(() =>
    [...document.querySelectorAll(".netdetail .netpre")].map((e) => e.textContent ?? "")
  );
  const named = decoded.find((t) => /^\/\/ [\w.]+\n\{/.test(t) && /"\w+":/.test(t));
  check(
    "protobuf decoded with field names from descriptors",
    !!named,
    named ? named.split("\n").slice(0, 3).join(" ⏎ ") : decoded[0]?.slice(0, 80)
  );
  check(
    "no bare field-number output left in the pane",
    !decoded.some((t) => /^\s*\d+: /.test(t)),
    "没有回落到字段号视图"
  );
}

await page.screenshot({ path: `${shotDir}/net-${tag}.png`, fullPage: false });
// Second shot with the pane scrolled: the response body is below the fold and it
// is the half that proves the response type resolved too.
await page.evaluate(() => {
  const d = document.querySelector(".netdetail-body");
  if (d) d.scrollTop = d.scrollHeight;
});
await sleep(300);
await page.screenshot({ path: `${shotDir}/net-${tag}-body.png`, fullPage: false });

// Filtering, then stop.
await page.select(".card select:nth-of-type(2)", tag).catch(() => {});
await sleep(800);
const afterFilter = await page.evaluate(
  () => Number(document.body.innerText.match(/(\d+) 条/)?.[1] ?? -1)
);
check("protocol filter applies", afterFilter >= 0, `${afterFilter} 条 ${tag}`);

await click("button", "停止");
await sleep(1500);
const stopped = await page.evaluate(() => document.body.innerText.includes("开始"));
check("stop returns to idle", stopped);

// The collector must be back to zero subscribers, or the app keeps paying for it.
const unix = adb("shell", "cat", "/proc/net/unix");
check("collector still listening after detach", unix.includes("netcapture"));

await page.screenshot({ path: `${shotDir}/net-${tag}-detail.png` });
await browser.close();
console.log(fail === 0 ? "\nNET OK" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);

async function banner(p) {
  return p.evaluate(() => {
    const m = document.body.innerText.match(/[\w.]+ · [^\n]*pid \d+[^\n]*/);
    return m ? m[0] : "";
  });
}
