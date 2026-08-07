// Animated WebP container writing, by hand.
//
// libwebp's encoder (compiled to wasm, see encode-webp.ts) produces one *still*
// WebP file per call. Turning a pile of those into an animation is pure
// container work — VP8X / ANIM / ANMF chunks around the bitstreams libwebp
// already gave us — so it lives here as plain byte pushing, with no wasm and no
// DOM. That also makes it the one piece of this feature that a node script can
// test directly (scripts/test-animwebp.mjs).
//
// The alternative was compiling libwebp's own `WebPAnimEncoder` (what the
// `img2webp` CLI uses) to wasm. That means an emscripten toolchain in the build,
// for a format documented in a page of spec. The bitstream — the part worth
// having a battle-tested C library for — is still libwebp's; only the RIFF
// wrapper is ours.
//
// Spec: https://developers.google.com/speed/webp/docs/riff_container

/** VP8X feature flags, from libwebp's `WebPFeatureFlags`. */
const ANIMATION_FLAG = 0x02;
const ALPHA_FLAG = 0x10;

/**
 * ANMF flags. Bit 0 is the disposal method (0 = leave the canvas alone), bit 1
 * the blending method (1 = overwrite instead of alpha-blending).
 */
const DISPOSE_NONE = 0x00;
const NO_BLEND = 0x02;

/** One frame, already encoded by libwebp and reduced to its bitstream chunks. */
export interface AnimFrame {
  /** `ALPH` (optional) followed by `VP8 ` or `VP8L`, as raw RIFF chunks. */
  bitstream: Uint8Array;
  /** Offset into the canvas. Must be even — ANMF stores these halved. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** How long this frame stays on screen, in milliseconds. */
  duration: number;
  hasAlpha: boolean;
}

export interface AnimOptions {
  width: number;
  height: number;
  /** 0 = forever. */
  loop: number;
  /** Canvas colour before the first frame, as [r,g,b,a]. Default transparent. */
  background?: [number, number, number, number];
  frames: AnimFrame[];
}

function u24(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff];
}

function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

function fourcc(tag: string): number[] {
  return [tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3)];
}

/** A RIFF chunk: tag, size, payload, and a pad byte when the size is odd. */
function chunk(tag: string, payload: ArrayLike<number>): Uint8Array {
  const pad = payload.length & 1;
  const out = new Uint8Array(8 + payload.length + pad);
  out.set(fourcc(tag), 0);
  out.set(u32(payload.length), 4);
  out.set(payload as Uint8Array, 8);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Assemble the animation.
 *
 * Frames are written with disposal=none and blending=off, i.e. each frame's
 * rectangle *replaces* what was there. That is what makes the cross-frame diff
 * in encode-webp.ts sound: the canvas after frame N is exactly frame N's
 * pixels, so the next diff can compare against the source image rather than
 * having to simulate a compositor.
 */
export function muxAnimatedWebp(opts: AnimOptions): Uint8Array {
  const { width, height, loop, frames } = opts;
  if (frames.length === 0) throw new Error("动图至少需要一帧");
  if (width < 1 || height < 1 || width > 1 << 24 || height > 1 << 24) {
    throw new Error(`画布尺寸非法：${width}x${height}`);
  }

  const bg = opts.background ?? [0, 0, 0, 0];
  const anyAlpha = frames.some((f) => f.hasAlpha);

  const vp8x = chunk("VP8X", [
    ANIMATION_FLAG | (anyAlpha ? ALPHA_FLAG : 0),
    0,
    0,
    0,
    ...u24(width - 1),
    ...u24(height - 1),
  ]);

  // Background is stored BGRA, and the loop count is the only 16-bit field in
  // the whole container.
  const anim = chunk("ANIM", [bg[2], bg[1], bg[0], bg[3], loop & 0xff, (loop >>> 8) & 0xff]);

  const anmfs = frames.map((f) => {
    if (f.x % 2 !== 0 || f.y % 2 !== 0) {
      throw new Error(`帧偏移必须是偶数（ANMF 里除以 2 存储），收到 ${f.x},${f.y}`);
    }
    if (f.x + f.width > width || f.y + f.height > height) {
      throw new Error(
        `帧 ${f.x},${f.y} ${f.width}x${f.height} 超出画布 ${width}x${height}`,
      );
    }
    const header = [
      ...u24(f.x / 2),
      ...u24(f.y / 2),
      ...u24(f.width - 1),
      ...u24(f.height - 1),
      // 24-bit duration: anything past ~4.6 hours per frame would wrap, and a
      // 0 means "as fast as possible" to most decoders, which is never what a
      // frame rate asked for.
      ...u24(Math.min(0xffffff, Math.max(1, Math.round(f.duration)))),
      DISPOSE_NONE | NO_BLEND,
    ];
    const payload = new Uint8Array(header.length + f.bitstream.length);
    payload.set(header, 0);
    payload.set(f.bitstream, header.length);
    return chunk("ANMF", payload);
  });

  const body = concat([vp8x, anim, ...anmfs]);
  // RIFF size covers "WEBP" plus everything after it.
  return concat([new Uint8Array(fourcc("RIFF")), new Uint8Array(u32(4 + body.length)), new Uint8Array(fourcc("WEBP")), body]);
}

export interface StillWebp {
  /** `ALPH` + `VP8 `/`VP8L` chunks, ready to drop into an ANMF. */
  bitstream: Uint8Array;
  hasAlpha: boolean;
  lossless: boolean;
  width: number;
  height: number;
}

/**
 * Pull the image bitstream out of a still WebP file.
 *
 * libwebp emits one of three shapes: a bare `VP8 ` (lossy), a bare `VP8L`
 * (lossless), or `VP8X` + `ALPH` + `VP8 ` (lossy with an alpha channel). An
 * ANMF wants everything except the VP8X — that information now belongs to the
 * animation's own header.
 */
export function parseStillWebp(bytes: Uint8Array): StillWebp {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tagAt = (off: number) => String.fromCharCode(...bytes.subarray(off, off + 4));

  if (bytes.length < 20 || tagAt(0) !== "RIFF" || tagAt(8) !== "WEBP") {
    throw new Error("不是 WebP 文件（RIFF/WEBP 头不匹配）");
  }

  const keep: Uint8Array[] = [];
  let hasAlpha = false;
  let lossless = false;
  let width = 0;
  let height = 0;

  let at = 12;
  const end = Math.min(bytes.length, 8 + view.getUint32(4, true));
  while (at + 8 <= end) {
    const tag = tagAt(at);
    const size = view.getUint32(at + 4, true);
    const payload = bytes.subarray(at + 8, at + 8 + size);

    if (tag === "VP8X") {
      hasAlpha ||= (payload[0] & ALPHA_FLAG) !== 0;
    } else if (tag === "ALPH") {
      hasAlpha = true;
      keep.push(chunk(tag, payload));
    } else if (tag === "VP8 ") {
      // Lossy keyframe header: 3-byte frame tag, the 0x9d012a sync code, then
      // 14-bit width and height each with 2 scale bits above them.
      if (payload.length >= 10) {
        width = view.getUint16(at + 8 + 6, true) & 0x3fff;
        height = view.getUint16(at + 8 + 8, true) & 0x3fff;
      }
      keep.push(chunk(tag, payload));
    } else if (tag === "VP8L") {
      lossless = true;
      // Signature byte, then a packed 32-bit field: w-1 (14), h-1 (14),
      // alpha_is_used (1), version (3).
      if (payload.length >= 5) {
        const bits = view.getUint32(at + 8 + 1, true);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
        hasAlpha ||= ((bits >>> 28) & 1) !== 0;
      }
      keep.push(chunk(tag, payload));
    }
    // Everything else (ICCP/EXIF/XMP) is metadata we deliberately drop.

    at += 8 + size + (size & 1);
  }

  if (keep.length === 0) throw new Error("WebP 里没有找到图像数据（VP8/VP8L）");
  return { bitstream: concat(keep), hasAlpha, lossless, width, height };
}
