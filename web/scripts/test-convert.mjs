// 转码 tab, checked against libwebp's own CLI.
//
//   node scripts/test-convert.mjs
//
// Two halves:
//
//   1. The arithmetic — natural sort, frame durations, fit rectangles, the
//      cross-frame diff box. Plain assertions.
//   2. The container. This is the part that could plausibly be wrong: we hand
//      libwebp's wasm build one still image per frame and assemble the RIFF /
//      VP8X / ANIM / ANMF structure ourselves. So the test builds a real
//      animation, then makes the *reference tools* read it back:
//
//        webpinfo  — does the container parse, and are canvas/frames/durations
//                    what we said they'd be
//        Pillow    — decode every frame to composited RGBA and compare against
//                    the pixels we started from (scripts/dump-webp-frames.py).
//                    Lossless in, lossless out, so any mistake in the
//                    sub-rectangle offsets or the "hold the previous frame" path
//                    shows up as an exact-match failure.
//
//      Needs libwebp (`brew install webp`) and python3 + Pillow; skips the parts
//      it can't run, with a warning.
//
// Not ffmpeg: its WebP decoder cannot read animated files whose frames are
// sub-rectangles — it fails identically on `img2webp`'s own output — so it has no
// opinion worth having here. (It is still used to *write* PNGs for the img2webp
// size comparison at the end.)
//
// The comparison against `img2webp` at the end is informational, not a
// pass/fail: same encoder, different frame strategy.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import encodeWebp, { init as initWebpEncoder } from "@jsquash/webp/encode.js";

import { parseStillWebp } from "../src/media/animwebp.ts";
import { diffBBox, fitRect, frameDurations, naturalCompare } from "../src/media/frames.ts";
import { AnimWebpBuilder } from "../src/media/sequence.ts";
import { DEFAULT_OPTIONS } from "../src/media/types.ts";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function has(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// --- 1. arithmetic ---------------------------------------------------------

{
  const names = ["f_10.png", "f_2.png", "f_1.png", "f_20.png"];
  check(
    "自然序排序",
    JSON.stringify([...names].sort(naturalCompare)) ===
      JSON.stringify(["f_1.png", "f_2.png", "f_10.png", "f_20.png"]),
  );

  const d30 = frameDurations(30, 30);
  check("30fps 30 帧 = 1000ms", d30.reduce((a, b) => a + b, 0) === 1000, `得到 ${d30.reduce((a, b) => a + b, 0)}ms`);
  check("30fps 单帧在 33/34ms 之间", d30.every((d) => d === 33 || d === 34));
  const d20 = frameDurations(20, 20);
  check("20fps 每帧 50ms", d20.every((d) => d === 50));

  // png2mp4.sh 的 decrease+pad：4:3 的图放进 1200x1920 应该上下留白、宽度顶满。
  const contain = fitRect(800, 600, 1200, 1920, "contain");
  check(
    "contain 等比缩放并居中",
    contain.w === 1200 && contain.h === 900 && contain.x === 0 && contain.y === 510,
    JSON.stringify(contain),
  );
  const cover = fitRect(800, 600, 1200, 1920, "cover");
  check("cover 铺满并裁切", cover.w === 2560 && cover.h === 1920 && cover.x === -680, JSON.stringify(cover));
  check(
    "stretch 忽略比例",
    JSON.stringify(fitRect(800, 600, 1200, 1920, "stretch")) ===
      JSON.stringify({ x: 0, y: 0, w: 1200, h: 1920 }),
  );

  const a = new Uint8ClampedArray(8 * 8 * 4);
  const b = new Uint8ClampedArray(8 * 8 * 4);
  check("完全相同 → 没有差异框", diffBBox(a, b, 8, 8) === null);
  // 改 (3,5) 一个像素：x/y 要退到偶数边界，尺寸补齐。
  b[(5 * 8 + 3) * 4] = 255;
  check(
    "单像素差异框退到偶数边界",
    JSON.stringify(diffBBox(a, b, 8, 8)) === JSON.stringify({ x: 2, y: 4, w: 2, h: 2 }),
    JSON.stringify(diffBBox(a, b, 8, 8)),
  );
}

// --- 2. a real animation, read back by libwebp and ffmpeg ------------------

const W = 96;
const H = 64;
const N = 12;
const FPS = 20;

/** Static gradient background, an 8x8 red square walking right. Frames 6/7 are identical. */
function makeFrame(i) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      data[p] = 20 + ((x * 2) % 60);
      data[p + 1] = 40 + ((y * 3) % 80);
      data[p + 2] = 90;
      data[p + 3] = 255;
    }
  }
  const step = i === 7 ? 6 : i; // frame 7 repeats frame 6 exactly
  const ox = 4 + step * 6;
  const oy = 20;
  for (let y = oy; y < oy + 8; y++) {
    for (let x = ox; x < ox + 8 && x < W; x++) {
      const p = (y * W + x) * 4;
      data[p] = 255;
      data[p + 1] = 0;
      data[p + 2] = 0;
      data[p + 3] = 255;
    }
  }
  return data;
}

const frames = Array.from({ length: N }, (_, i) => makeFrame(i));
const durations = frameDurations(N, FPS);

// libwebp's wasm, instantiated the same way the browser does it: compile the
// module ourselves and hand it to init(), so the emscripten glue never tries to
// fetch anything.
const wasmPath = new URL(
  "../node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm",
  import.meta.url,
);
await initWebpEncoder(await WebAssembly.compile(readFileSync(wasmPath)));

async function build(opts) {
  const builder = new AnimWebpBuilder(W, H, opts, async (pixels, o) => {
    const still = await encodeWebp(pixels, {
      lossless: o.lossless ? 1 : 0,
      quality: o.quality,
      method: o.method,
      near_lossless: o.lossless ? o.nearLossless : 100,
      exact: o.exact ? 1 : 0,
    });
    return new Uint8Array(still);
  });
  for (let i = 0; i < N; i++) await builder.addFrame({ data: frames[i], width: W, height: H }, durations[i]);
  return builder.finish();
}

const webpOpts = { ...DEFAULT_OPTIONS.webp, lossless: true, method: 4 };
const diffed = await build(webpOpts);
const whole = await build({ ...webpOpts, diff: false });

check(
  "差分模式帧数少一（第 7 帧与第 6 帧相同，已合并）",
  diffed.frames === N - 1 && whole.frames === N,
  `diff=${diffed.frames} full=${whole.frames}`,
);
check("总时长两种模式一致", diffed.durationMs === whole.durationMs && diffed.durationMs === 600);
check(
  "差分产物明显更小",
  diffed.bytes.length < whole.bytes.length * 0.6,
  `${diffed.bytes.length}B vs ${whole.bytes.length}B`,
);

// The still-WebP parser, on output from the real encoder.
{
  const still = new Uint8Array(
    await encodeWebp({ data: frames[0], width: W, height: H }, { lossless: 1, method: 4 }),
  );
  const parsed = parseStillWebp(still);
  check(
    "解析 libwebp 单帧输出（VP8L 尺寸/无 alpha）",
    parsed.lossless && parsed.width === W && parsed.height === H && !parsed.hasAlpha,
    JSON.stringify({ ...parsed, bitstream: `${parsed.bitstream.length}B` }),
  );
}

const dir = mkdtempSync(join(tmpdir(), "convert-test-"));
const ours = join(dir, "ours.webp");
writeFileSync(ours, diffed.bytes);
console.log(`\n产物：${ours}`);

if (!has("webpinfo")) {
  console.log("SKIP  webpinfo 不在 PATH（brew install webp）");
} else {
  const info = execFileSync("webpinfo", [ours], { encoding: "utf8" });
  check("webpinfo 认这个容器", /No error detected|Errors detected: 0/i.test(info) || !/error/i.test(info));
  check("画布尺寸", info.includes(`Canvas size ${W} x ${H}`), `期望 ${W} x ${H}`);
  const anmf = (info.match(/ANMF/g) ?? []).length;
  check("ANMF 数量 = 合并后的帧数", anmf === diffed.frames, `${anmf} 个`);
  const loops = /Loop count\s*:\s*0/.test(info);
  check("循环次数 0（无限）", loops);
  const durs = [...info.matchAll(/Duration:\s*(\d+)/g)].map((m) => Number(m[1]));
  const total = durs.reduce((a, b) => a + b, 0);
  check("每帧时长之和 = 600ms", total === 600, `${total}ms（${durs.join("/")}）`);
}

// Decode it back with libwebp's own animation decoder (through Pillow) and compare
// pixel for pixel. This is the check that the ANMF offsets and the
// replace-don't-blend flags are right: a wrong offset shifts the square, a wrong
// blend mode leaves ghosts, and lossless in/lossless out means any of that shows
// up as an exact-match failure.
let pillow = true;
try {
  execFileSync("python3", ["-c", "import PIL"], { stdio: "pipe" });
} catch {
  pillow = false;
}

if (!pillow) {
  console.log("SKIP  python3 + Pillow 不可用 —— 跳过逐像素回读（pip install pillow）");
} else {
  const framesDir = mkdtempSync(join(tmpdir(), "convert-frames-"));
  const summary = JSON.parse(
    execFileSync("python3", [new URL("dump-webp-frames.py", import.meta.url).pathname, ours, framesDir], {
      encoding: "utf8",
    }),
  );

  check("libwebp 解码器读到的帧数", summary.frames === diffed.frames, `${summary.frames} 帧`);
  check(
    "libwebp 解码器读到的画布",
    summary.size[0] === W && summary.size[1] === H,
    summary.size.join("x"),
  );
  check(
    "每帧时长（解码器视角）",
    summary.durations.reduce((a, b) => a + b, 0) === 600,
    summary.durations.join("/"),
  );

  // Frame 7 was merged into frame 6, so the decoder emits one image fewer —
  // compare against the source sequence with that duplicate dropped.
  const expected = frames.filter((_, i) => i !== 7);
  let mismatched = 0;
  let worst = 0;
  for (let i = 0; i < Math.min(summary.frames, expected.length); i++) {
    const got = readFileSync(join(framesDir, `${String(i).padStart(4, "0")}.rgba`));
    let bad = 0;
    for (let p = 0; p < got.length; p++) {
      const d = Math.abs(got[p] - expected[i][p]);
      if (d !== 0) {
        bad += 1;
        worst = Math.max(worst, d);
      }
    }
    if (bad > 0) mismatched += 1;
  }
  check(
    "无损往返：每帧逐像素一致",
    mismatched === 0,
    mismatched === 0 ? "" : `${mismatched} 帧不一致，最大偏差 ${worst}`,
  );
}

// --- informational: how img2webp does on the same frames -------------------

if (has("ffmpeg") && has("img2webp")) {
  const pngs = [];
  for (let i = 0; i < N; i++) {
    const rawPath = join(dir, `f${String(i).padStart(3, "0")}.rgba`);
    const png = join(dir, `f${String(i).padStart(3, "0")}.png`);
    writeFileSync(rawPath, frames[i]);
    execFileSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-i", rawPath, png],
      { stdio: "pipe" },
    );
    pngs.push(png);
  }
  const ref = join(dir, "img2webp.webp");
  execFileSync("img2webp", ["-lossless", "-d", "50", "-m", "4", "-o", ref, ...pngs], { stdio: "pipe" });
  const refSize = readFileSync(ref).length;
  console.log(
    `\n参考：img2webp -lossless -d 50 -m 4 = ${refSize}B；` +
      `本实现差分 = ${diffed.bytes.length}B，整帧 = ${whole.bytes.length}B`,
  );
} else {
  console.log("\nSKIP  需要 ffmpeg + img2webp 才能和 CLI 对比体积");
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
