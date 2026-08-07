// Frames → animation, with the still encoder passed in.
//
// Split out of encode-webp.ts on purpose: everything here is arithmetic on pixel
// buffers, and the caller supplies "encode this rectangle as a still WebP". That
// keeps the interesting logic — which rectangle changed, when a frame can be
// dropped into the previous one's duration — free of wasm and DOM, so
// scripts/test-convert.mjs can run *this* code in node against the real libwebp
// encoder rather than a re-implementation of it.

import { muxAnimatedWebp, parseStillWebp, type AnimFrame } from "./animwebp.ts";
import { diffBBox } from "./frames.ts";
import type { WebpOptions } from "./types.ts";

/** Just enough of `ImageData` to encode: node has no such constructor. */
export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Encodes one still image. In the browser this is libwebp-in-wasm. */
export type StillEncoder = (pixels: PixelBuffer, opts: WebpOptions) => Promise<Uint8Array>;

export interface AnimResult {
  bytes: Uint8Array;
  mime: string;
  frames: number;
  durationMs: number;
}

export class AnimWebpBuilder {
  private readonly frames: AnimFrame[] = [];
  private prev: Uint8ClampedArray | undefined;
  /** Reused across frames so a long run doesn't allocate one buffer per frame. */
  private crop: { data: Uint8ClampedArray; w: number; h: number } | undefined;

  private readonly width: number;
  private readonly height: number;
  private readonly opts: WebpOptions;
  private readonly encodeStill: StillEncoder;

  // Spelled out rather than declared as constructor parameters: node's
  // type-stripping loader rejects parameter properties, and this module is meant
  // to be importable from scripts/test-convert.mjs.
  constructor(width: number, height: number, opts: WebpOptions, encodeStill: StillEncoder) {
    this.width = width;
    this.height = height;
    this.opts = opts;
    this.encodeStill = encodeStill;
  }

  async addFrame(image: PixelBuffer, durationMs: number): Promise<void> {
    // The first frame always covers the canvas: a decoder starts from the
    // background colour, so a partial first frame would leave it showing.
    let box = { x: 0, y: 0, w: this.width, h: this.height };

    if (this.prev && this.opts.diff) {
      const changed = diffBBox(this.prev, image.data, this.width, this.height);
      if (!changed) {
        // Nothing moved. Rather than spend a frame on it, hold the previous one
        // longer — same playback, one less ANMF.
        this.frames[this.frames.length - 1].duration += durationMs;
        return;
      }
      box = changed;
    }

    const pixels =
      box.w === this.width && box.h === this.height ? image : this.cropped(image, box);
    const parsed = parseStillWebp(await this.encodeStill(pixels, this.opts));

    this.frames.push({
      bitstream: parsed.bitstream,
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      duration: durationMs,
      hasAlpha: parsed.hasAlpha,
    });

    // Copy: the caller's canvas is about to be drawn over. And because frames
    // replace their rectangle rather than blending, the canvas now *is* this
    // image — which is what makes the next diff a straight comparison.
    this.prev ??= new Uint8ClampedArray(image.data.length);
    this.prev.set(image.data);
  }

  private cropped(image: PixelBuffer, box: { x: number; y: number; w: number; h: number }): PixelBuffer {
    if (!this.crop || this.crop.w !== box.w || this.crop.h !== box.h) {
      this.crop = { data: new Uint8ClampedArray(box.w * box.h * 4), w: box.w, h: box.h };
    }
    const { data } = this.crop;
    const stride = this.width * 4;
    for (let row = 0; row < box.h; row++) {
      const from = (box.y + row) * stride + box.x * 4;
      data.set(image.data.subarray(from, from + box.w * 4), row * box.w * 4);
    }
    return { data, width: box.w, height: box.h };
  }

  finish(): AnimResult {
    return {
      bytes: muxAnimatedWebp({
        width: this.width,
        height: this.height,
        loop: this.opts.loop,
        frames: this.frames,
      }),
      mime: "image/webp",
      frames: this.frames.length,
      durationMs: this.frames.reduce((n, f) => n + f.duration, 0),
    };
  }
}
