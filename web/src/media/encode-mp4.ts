// MP4, via the browser's own video encoder.
//
// scripts/png2mp4.sh calls ffmpeg with libx265 and `-crf 33`. In a page the
// encoder is WebCodecs — hardware-backed on every machine that can run this app,
// which is why a 300-frame 1200x1920 sequence takes seconds rather than the
// minutes an ffmpeg.wasm build would need for the same work.
//
// Two honest differences from the script:
//
//   * There is no CRF. WebCodecs exposes a target bitrate, so quality is set as
//     Mbps instead of a quantiser. A variable bitrate mode lets the encoder drift
//     above/below the target per frame, which is as close to constant-quality as
//     the API gets.
//   * HEVC depends on the machine. Every Chrome can encode H.264; HEVC needs OS
//     support (macOS has it, most Windows GPUs do, Linux usually doesn't). The UI
//     only offers what `isConfigSupported` accepts, probed at load.

import { ArrayBufferTarget, Muxer } from "mp4-muxer";

import type { Mp4Codec, Mp4Options } from "./types.ts";

/**
 * Codec strings to try, best first. Levels are deliberately generous — a level
 * too low for the resolution is rejected outright, and there is no cost to
 * declaring headroom.
 */
const CANDIDATES: Record<Mp4Codec, string[]> = {
  avc: ["avc1.640034", "avc1.64002A", "avc1.4D0034", "avc1.42E01E"],
  hevc: ["hvc1.1.6.L153.B0", "hev1.1.6.L153.B0", "hvc1.1.6.L120.B0"],
  vp9: ["vp09.00.51.08", "vp09.00.10.08"],
  av1: ["av01.0.09M.08", "av01.0.04M.08"],
};

export interface Probe {
  codec: Mp4Codec;
  supported: boolean;
}

/** Which codecs this browser/machine can actually encode, at this size. */
export async function probeCodecs(width: number, height: number, fps: number): Promise<Probe[]> {
  const codecs = Object.keys(CANDIDATES) as Mp4Codec[];
  return Promise.all(
    codecs.map(async (codec) => ({
      codec,
      supported: (await pickCodecString(codec, width, height, fps, 4_000_000)) !== null,
    })),
  );
}

async function pickCodecString(
  codec: Mp4Codec,
  width: number,
  height: number,
  framerate: number,
  bitrate: number,
): Promise<string | null> {
  if (typeof VideoEncoder === "undefined") return null;
  for (const candidate of CANDIDATES[codec]) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({
        codec: candidate,
        width,
        height,
        framerate,
        bitrate,
        // The muxer needs length-prefixed samples plus a decoder config, not
        // Annex-B start codes.
        ...(codec === "avc" ? { avc: { format: "avc" as const } } : {}),
        ...(codec === "hevc" ? { hevc: { format: "hevc" as const } } : {}),
      });
      if (supported) return candidate;
    } catch {
      // A malformed codec string throws instead of reporting unsupported.
    }
  }
  return null;
}

export class Mp4Encoder {
  private frames = 0;

  private constructor(
    private readonly encoder: VideoEncoder,
    private readonly muxer: Muxer<ArrayBufferTarget>,
    private readonly target: ArrayBufferTarget,
    private readonly fps: number,
    private readonly keyEvery: number,
  ) {}

  static async create(
    width: number,
    height: number,
    fps: number,
    opts: Mp4Options,
  ): Promise<Mp4Encoder> {
    if (typeof VideoEncoder === "undefined") {
      throw new Error("这个浏览器没有 WebCodecs，无法编码视频（Chrome / Edge 可用）");
    }
    const bitrate = Math.round(opts.bitrateMbps * 1_000_000);
    const codecString = await pickCodecString(opts.codec, width, height, fps, bitrate);
    if (!codecString) {
      throw new Error(`这台机器不支持用 ${opts.codec.toUpperCase()} 编码 ${width}x${height}`);
    }

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: opts.codec, width, height, frameRate: fps },
      // Metadata up front, so the file plays without a seek to the end. The cost
      // is holding the samples in memory, which for a few hundred frames is fine.
      fastStart: "in-memory",
    });

    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        throw e;
      },
    });
    encoder.configure({
      codec: codecString,
      width,
      height,
      framerate: fps,
      bitrate,
      // "variable" lets the encoder spend more than the target on a hard frame
      // and less on an easy one — the closest this API gets to ffmpeg's CRF.
      bitrateMode: "variable",
      latencyMode: "quality",
      ...(opts.codec === "avc" ? { avc: { format: "avc" as const } } : {}),
      ...(opts.codec === "hevc" ? { hevc: { format: "hevc" as const } } : {}),
    });

    return new Mp4Encoder(
      encoder,
      muxer,
      target,
      fps,
      Math.max(1, Math.round(opts.keyframeSec * fps)),
    );
  }

  async addFrame(canvas: OffscreenCanvas): Promise<void> {
    const index = this.frames++;
    // Microseconds, derived from the index rather than accumulated, so rounding
    // can't drift over a long sequence.
    const timestamp = Math.round((index * 1_000_000) / this.fps);
    const duration = Math.round(((index + 1) * 1_000_000) / this.fps) - timestamp;
    const frame = new VideoFrame(canvas, { timestamp, duration });
    this.encoder.encode(frame, { keyFrame: index % this.keyEvery === 0 });
    frame.close();

    // Don't run arbitrarily far ahead of the encoder: each queued frame holds a
    // full-size buffer, and 300 of them at 1200x1920 is 2.7 GB.
    if (this.encoder.encodeQueueSize > 8) {
      await new Promise<void>((res) => {
        this.encoder.addEventListener("dequeue", () => res(), { once: true });
      });
    }
  }

  async finish(): Promise<{ bytes: Uint8Array; mime: string; frames: number; durationMs: number }> {
    await this.encoder.flush();
    this.encoder.close();
    this.muxer.finalize();
    return {
      bytes: new Uint8Array(this.target.buffer),
      mime: "video/mp4",
      frames: this.frames,
      durationMs: Math.round((this.frames * 1000) / this.fps),
    };
  }
}
