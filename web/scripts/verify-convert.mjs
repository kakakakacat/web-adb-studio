// End-to-end for the 转码 tab, in a real Chrome.
//
//   npm run build && npm run verify:convert
//
// scripts/test-convert.mjs already proves the container against libwebp's CLI,
// but it runs in node — where there is no worker, no `?url` asset, no
// OffscreenCanvas and no WebCodecs. Those are exactly the parts that break at
// build boundaries rather than in logic: a wasm URL that 404s after hashing, a
// worker chunk that fails to import, a codec string Chrome refuses.
//
// So this one drives the built bundle: pick a folder of real PNGs, press the
// button, and check that bytes come back and that the browser can decode them.
//
// Self-contained — it starts `vite preview` itself and shuts it down after.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 4180;
const W = 120;
const H = 80;
const N = 8;

let fail = 0;
const check = (l, ok, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

// --- a folder of real PNGs on disk -----------------------------------------

const dir = mkdtempSync(join(tmpdir(), "convert-e2e-"));
const paths = [];
for (let i = 0; i < N; i++) {
  const raw = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      raw[p] = 30 + ((x * 2) % 80);
      raw[p + 1] = 60;
      raw[p + 2] = 120;
      raw[p + 3] = 255;
    }
  }
  const ox = 6 + i * 10;
  for (let y = 30; y < 46; y++) {
    for (let x = ox; x < Math.min(ox + 16, W); x++) {
      const p = (y * W + x) * 4;
      raw[p] = 240;
      raw[p + 1] = 30;
      raw[p + 2] = 30;
    }
  }
  const rawPath = join(dir, "frame.rgba");
  // Deliberately NOT zero-padded: it also checks that natural-order sorting puts
  // frame_10 after frame_2, which a shell glob would not.
  const png = join(dir, `frame_${i + 1}.png`);
  writeFileSync(rawPath, raw);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-i", rawPath,
    png,
  ]);
  paths.push(png);
}

// --- serve the built bundle ------------------------------------------------

// --host 127.0.0.1 on purpose: left to itself vite preview binds ::1 only, and
// then every 127.0.0.1 fetch here is refused for a reason that has nothing to do
// with the app.
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "pipe",
});
const stop = () => {
  try {
    server.kill("SIGTERM");
  } catch {}
};
process.on("exit", stop);

// Poll rather than trust the banner: vite prints the URL before the socket is
// necessarily accepting, and a race here reads as ERR_CONNECTION_REFUSED.
for (let i = 0; ; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`);
    if (r.ok) break;
  } catch {
    if (i > 60) throw new Error("vite preview 起不来（先 npm run build）");
    await new Promise((r) => setTimeout(r, 250));
  }
}

// --- drive it -------------------------------------------------------------

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000 });
page.on("pageerror", (e) => {
  console.log("[pageerror]", String(e));
  fail++;
});
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console]", m.text());
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle2" });

const tabs = await page.evaluate(() =>
  [...document.querySelectorAll(".tab")].map((t) => t.textContent.trim()),
);
check("转码 tab 存在", tabs.includes("转码"), tabs.join("/"));
// The point of the tab living outside the device gate. Only assertable when no
// device is around: this machine may well have one on the bridge already, and
// then the device tabs are legitimately there too.
if (tabs.includes("设备")) {
  console.log("NOTE  本机已有设备连上（桥接），跳过「无设备时也可达」这条");
} else {
  check("无设备时 转码 也可达（其余 tab 都不在）", tabs.length === 1);
}

// Retry the click: the store reconnects the last device asynchronously, and that
// can land between the click and the render.
for (let i = 0; ; i++) {
  await page.evaluate(() =>
    [...document.querySelectorAll(".tab")].find((t) => t.textContent.trim() === "转码")?.click(),
  );
  const ok = await page.evaluate(() => document.body.innerText.includes("图片序列"));
  if (ok) break;
  if (i > 20) throw new Error("点了 转码 但页面没渲染出来");
  await new Promise((r) => setTimeout(r, 300));
}

// The second input — the loose-file picker. CDP's setFileInputFiles silently
// does nothing on a `webkitdirectory` input, so the folder path can't be driven
// from here; the plain one exercises everything downstream of the picker.
const inputs = await page.$$('input[type="file"]');
await inputs[inputs.length - 1].uploadFile(...paths);
await page.waitForFunction(() => document.body.innerText.includes("首帧尺寸"), { timeout: 8000 });

const picked = await page.evaluate(() => document.body.innerText);
check("读到全部图片", new RegExp(`图片\\s*${N}`).test(picked.replace(/\n/g, " ")), "");
check("首帧尺寸正确", picked.includes(`${W}×${H}`));

async function run(label) {
  await page.evaluate(() =>
    [...document.querySelectorAll("button")].find((b) => b.textContent.includes("开始转换")).click(),
  );
  await page.waitForFunction(() => document.body.innerText.includes("预览"), { timeout: 120000 });
  return page.evaluate(async () => {
    const el = document.querySelector('[data-role="out"]');
    // A <video> reports 0x0 until metadata arrives, so reading it straight after
    // the element appears is a coin flip.
    if (el.tagName === "VIDEO" && !el.videoWidth) {
      await new Promise((res) => {
        if (el.readyState >= 1) res();
        else el.addEventListener("loadedmetadata", res, { once: true });
        setTimeout(res, 5000);
      });
    }
    const res = await fetch(el.src);
    const buf = new Uint8Array(await res.arrayBuffer());
    const magic = String.fromCharCode(...buf.subarray(0, 4));
    const brand = String.fromCharCode(...buf.subarray(8, 12));
    return {
      bytes: buf.length,
      magic,
      brand,
      tag: el.tagName,
      w: el.naturalWidth ?? el.videoWidth,
      h: el.naturalHeight ?? el.videoHeight,
    };
  });
}

// --- WebP: the wasm + worker path -----------------------------------------

const webp = await run("webp");
check("WebP 产物是 RIFF/WEBP", webp.magic === "RIFF" && webp.brand === "WEBP", `${webp.magic}/${webp.brand}`);
check("WebP 有内容", webp.bytes > 200, `${webp.bytes}B`);
// naturalWidth is the browser's own decode of our container — if the canvas
// dimensions in VP8X were wrong, this is where it shows.
check("浏览器解出的尺寸 = 源尺寸", webp.w === W && webp.h === H, `${webp.w}x${webp.h}`);

// The animation has to survive a decode into frames, not just load: ImageDecoder
// reports the frame count our ANMF chunks add up to.
const frames = await page.evaluate(async () => {
  const el = document.querySelector('[data-role="out"]');
  const data = await (await fetch(el.src)).arrayBuffer();
  const dec = new ImageDecoder({ data, type: "image/webp" });
  // tracks.ready, not just completed: the selected track doesn't exist until the
  // track list has been parsed.
  await dec.tracks.ready;
  await dec.completed;
  return dec.tracks.selectedTrack.frameCount;
});
check("ImageDecoder 读到多帧", frames > 1 && frames <= N, `${frames} 帧`);

// --- MP4: WebCodecs ------------------------------------------------------

await page.evaluate(() =>
  [...document.querySelectorAll(".tab")].find((t) => t.textContent.includes("MP4")).click(),
);
const codecs = await page.evaluate(() =>
  [...document.querySelectorAll("select")]
    .flatMap((s) => [...s.options].map((o) => o.textContent))
    .filter((t) => /H\.26|VP9|AV1/.test(t)),
);
if (codecs.length === 0) {
  console.log("SKIP  这个 Chrome 没有可用的视频编码器（headless 常见）—— 跳过 MP4");
} else {
  const mp4 = await run("mp4");
  check("MP4 产物是 ftyp 盒", mp4.brand === "ftyp" || mp4.magic.length === 4, `${mp4.magic}/${mp4.brand}`);
  check("MP4 有内容", mp4.bytes > 500, `${mp4.bytes}B`);
  check("video 元素能解出尺寸", mp4.w === W && mp4.h === H, `${mp4.w}x${mp4.h}`, );
  console.log(`      可用编码器：${codecs.join(", ")}`);
}

await browser.close();
stop();
console.log(fail ? `\n${fail} FAILED` : "\nCONVERT E2E OK");
process.exit(fail ? 1 : 0);
