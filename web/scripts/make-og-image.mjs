#!/usr/bin/env node
// 生成 public/og.png（1200×630），社交平台和部分搜索结果会用它做预览图。
//
// 为什么用 puppeteer 渲 HTML 而不是画图工具：这台机器上没有 ImageMagick 之类的东西，
// 而 puppeteer 已经是 devDependency（UI 验证脚本在用）。HTML 也更好改。
//
// 产物是提交进仓库的（构建时直接复制），不需要每次发布重新生成 —— 只有改了文案或
// 配色才跑一次：
//   node scripts/make-og-image.mjs

import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; display: flex; flex-direction: column;
    justify-content: center; gap: 26px; padding: 0 86px;
    background: radial-gradient(120% 120% at 12% 0%, #14342f 0%, #0e1014 55%);
    color: #eceef2;
    font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
  }
  .brand { display: flex; align-items: center; gap: 18px; }
  .mark { width: 60px; height: 60px; border-radius: 14px; background: #2dd4bf; position: relative; }
  .mark::after {
    content: ""; position: absolute; inset: 13px 17px; background: #05221f; border-radius: 3px;
  }
  .brand span { font-size: 40px; font-weight: 700; letter-spacing: -0.02em; }
  h1 { font-size: 62px; line-height: 1.14; font-weight: 800; letter-spacing: -0.03em; }
  h1 em { font-style: normal; color: #2dd4bf; }
  p { font-size: 29px; line-height: 1.5; color: #a8b0be; max-width: 940px; }
  .url { margin-top: 8px; font-size: 27px; color: #5eead4; font-weight: 600; }
</style></head><body>
  <div class="brand"><div class="mark"></div><span>ADB Studio</span></div>
  <h1>浏览器直连安卓设备<br><em>不用装 adb，不用装客户端</em></h1>
  <p>投屏 · 装包 · 文件传输 · 实时日志 · HTTP / gRPC / WebSocket 抓包（应用层明文，无需 MITM 代理和证书）</p>
  <div class="url">adb.kakacat.net</div>
</body></html>`;

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
// deviceScaleFactor 1：og 图按 1200×630 使用，渲成 2x 只会让文件白白变大。
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.setContent(HTML, { waitUntil: "load" });
const png = await page.screenshot({ type: "png" });
writeFileSync("public/og.png", png);
await browser.close();
console.log(`public/og.png 已生成 (${(png.length / 1024).toFixed(0)} KB)`);
