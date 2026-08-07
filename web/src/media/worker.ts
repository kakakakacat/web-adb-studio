// The conversion itself, off the main thread.
//
// A worker is not a nicety here: `createImageBitmap` + a full-canvas
// `getImageData` + a wasm libwebp call per frame, a few hundred times over, would
// otherwise freeze the page for the whole run — and this app has a device
// connection and a logcat stream to keep serving while it works.
//
// Cancelling is `worker.terminate()` from the UI. There is no cooperative stop
// flag because there is nothing to unwind: the output only exists once finish()
// runs.

import { Mp4Encoder } from "./encode-mp4.ts";
import { createWebpEncoder } from "./encode-webp.ts";
import { FrameCanvas, frameDurations, targetSize } from "./frames.ts";
import type { JobRequest, WorkerOut } from "./types.ts";

function post(msg: WorkerOut, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

async function run(req: JobRequest): Promise<void> {
  const { opts } = req;
  const files = req.files.filter((_, i) => i % Math.max(1, opts.step) === 0);
  if (files.length === 0) throw new Error("没有可用的图片");

  const probe = await createImageBitmap(files[0]);
  const { width, height } = targetSize(opts.size, probe, opts.format === "mp4");
  probe.close();

  const canvas = new FrameCanvas(width, height, opts.size.fit, opts.size.pad);
  const durations = frameDurations(files.length, opts.fps);

  const webp =
    opts.format === "webp" ? await createWebpEncoder(width, height, opts.webp) : null;
  const mp4 =
    opts.format === "mp4" ? await Mp4Encoder.create(width, height, opts.fps, opts.mp4) : null;

  for (let i = 0; i < files.length; i++) {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(files[i]);
    } catch (e) {
      throw new Error(`第 ${i + 1} 张「${files[i].name}」解不开：${(e as Error).message}`);
    }
    canvas.draw(bitmap);
    bitmap.close();

    if (webp) await webp.addFrame(canvas.pixels(), durations[i]);
    else await mp4!.addFrame(canvas.canvas);

    post({ type: "progress", done: i + 1, total: files.length, phase: "encode" });
  }

  post({ type: "progress", done: files.length, total: files.length, phase: "finalize" });
  const out = webp ? webp.finish() : await mp4!.finish();

  // The bytes are handed over, not copied — a 40 MB structured clone of an
  // ArrayBuffer is pure waste when nothing here needs it afterwards.
  const buffer = out.bytes.buffer.slice(
    out.bytes.byteOffset,
    out.bytes.byteOffset + out.bytes.byteLength,
  ) as ArrayBuffer;
  post(
    {
      type: "done",
      buffer,
      mime: out.mime,
      frames: out.frames,
      width,
      height,
      durationMs: out.durationMs,
    },
    [buffer],
  );
}

self.onmessage = (e: MessageEvent<JobRequest>) => {
  run(e.data).catch((err: unknown) => {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  });
};
