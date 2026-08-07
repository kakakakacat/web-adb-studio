// Animated WebP: wiring libwebp's wasm build into the sequence builder.
//
// The bitstream comes from libwebp itself — @jsquash/webp is libwebp's encoder
// compiled to wasm, exposing the whole `WebPConfig` struct, so the page's knobs
// are the same ones `img2webp`/`cwebp` take (`-lossless`, `-q`, `-m`,
// `-near_lossless`, `-exact`). The container and the frame arithmetic are ours
// (animwebp.ts, sequence.ts).

import encodeWebp, { init as initWebpEncoder } from "@jsquash/webp/encode";
import simdWasmUrl from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?url";
import plainWasmUrl from "@jsquash/webp/codec/enc/webp_enc.wasm?url";
import { simd } from "wasm-feature-detect";

import { AnimWebpBuilder, type PixelBuffer } from "./sequence.ts";
import type { WebpOptions } from "./types.ts";

let ready: Promise<unknown> | undefined;

/**
 * Hand libwebp's wasm over explicitly.
 *
 * Left to itself the emscripten glue fetches `webp_enc.wasm` relative to its own
 * URL, which is a path inside node_modules that survives neither bundling nor
 * the hashed-asset layout Vite ships. `?url` makes it a real build asset, and
 * `init(module)` skips the glue's fetch entirely.
 */
function initEncoder(): Promise<unknown> {
  ready ??= (async () => {
    // init() picks the SIMD glue by the same feature test, so the module we
    // compile has to match what it's about to instantiate.
    const url = (await simd()) ? simdWasmUrl : plainWasmUrl;
    const module = await WebAssembly.compileStreaming(fetch(url));
    return initWebpEncoder(module);
  })();
  return ready;
}

/** libwebp's `WebPConfig`, filled in from the page's controls. */
export function webpConfig(opts: WebpOptions) {
  return {
    lossless: opts.lossless ? 1 : 0,
    quality: opts.quality,
    method: opts.method,
    // near_lossless only means anything in lossless mode, and 100 is "off".
    near_lossless: opts.lossless ? opts.nearLossless : 100,
    exact: opts.exact ? 1 : 0,
  };
}

export async function createWebpEncoder(
  width: number,
  height: number,
  opts: WebpOptions,
): Promise<AnimWebpBuilder> {
  await initEncoder();
  return new AnimWebpBuilder(width, height, opts, async (pixels: PixelBuffer, o) => {
    // jsquash types the argument as ImageData; it only reads data/width/height.
    const still = await encodeWebp(pixels as ImageData, webpConfig(o));
    return new Uint8Array(still);
  });
}
