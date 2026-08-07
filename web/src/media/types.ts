// Shared vocabulary between the UI (ui/Convert.tsx) and the worker that does the
// encoding (media/worker.ts). Kept free of DOM and wasm imports so both sides —
// and the node tests — can pull it in.

export type Fit = "contain" | "cover" | "stretch";

export interface SizeOptions {
  /** `original` takes the first frame's size and fits the rest into it. */
  mode: "original" | "custom";
  width: number;
  height: number;
  /**
   * How a frame that doesn't match the canvas is placed:
   *   contain — scale down to fit, pad the rest (png2mp4.sh's
   *             `force_original_aspect_ratio=decrease` + `pad`)
   *   cover   — scale up to fill, crop the overflow
   *   stretch — ignore the aspect ratio
   */
  fit: Fit;
  /** Pad colour as `#rrggbb`, or "transparent" (WebP only). */
  pad: string;
}

export interface WebpOptions {
  /** img2webp's `-lossless`. */
  lossless: boolean;
  /** libwebp `quality` 0–100. Under lossless it steers the effort/size tradeoff. */
  quality: number;
  /** img2webp's `-m`: 0 fastest … 6 slowest/smallest. */
  method: number;
  /** 100 = off. Lower values pre-quantise before lossless coding. */
  nearLossless: number;
  /** Keep the RGB of fully transparent pixels instead of clearing it. */
  exact: boolean;
  /** 0 = loop forever. */
  loop: number;
  /** Encode only the rectangle that changed since the previous frame. */
  diff: boolean;
}

export type Mp4Codec = "avc" | "hevc" | "vp9" | "av1";

export interface Mp4Options {
  codec: Mp4Codec;
  /** Target bitrate. WebCodecs has no CRF knob — see encode-mp4.ts. */
  bitrateMbps: number;
  /** Seconds between keyframes. */
  keyframeSec: number;
}

export interface JobOptions {
  format: "webp" | "mp4";
  fps: number;
  /** Keep every Nth frame. 1 = all of them. */
  step: number;
  size: SizeOptions;
  webp: WebpOptions;
  mp4: Mp4Options;
}

export interface JobRequest {
  files: File[];
  opts: JobOptions;
}

export type WorkerOut =
  | { type: "progress"; done: number; total: number; phase: string }
  | {
      type: "done";
      buffer: ArrayBuffer;
      mime: string;
      frames: number;
      width: number;
      height: number;
      durationMs: number;
    }
  | { type: "error"; message: string };

export const DEFAULT_OPTIONS: JobOptions = {
  format: "webp",
  fps: 20,
  step: 1,
  size: { mode: "original", width: 1200, height: 1920, fit: "contain", pad: "#000000" },
  // Defaults match scripts/img2webp.sh: `img2webp -lossless -d 50 -m 4`.
  webp: { lossless: true, quality: 75, method: 4, nearLossless: 100, exact: false, loop: 0, diff: true },
  mp4: { codec: "avc", bitrateMbps: 8, keyframeSec: 2 },
};
