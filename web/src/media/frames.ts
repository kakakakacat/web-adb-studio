// Turning a folder the user picked into a sequence of same-sized RGBA frames.
//
// Decoding is the browser's job: `createImageBitmap` handles PNG and JPEG (and
// WebP) natively, off the main thread and without shipping a decoder. So the
// only work here is picking the files, getting them in the right order, and
// fitting them onto one canvas — the equivalent of the ffmpeg
// `scale=…:force_original_aspect_ratio=decrease,pad=…` filter in
// scripts/png2mp4.sh.

import type { Fit, SizeOptions } from "./types.ts";

/** WebP is decodable too, so it's allowed as *input* even though it's an odd choice. */
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

export function isImage(name: string): boolean {
  // Skip macOS resource forks and Finder droppings, which match the extension
  // test but aren't images.
  const base = name.split("/").pop() ?? name;
  if (base.startsWith(".")) return false;
  return IMAGE_RE.test(base);
}

/**
 * Filename order, the way a human reads it: `frame_2.png` before `frame_10.png`.
 *
 * The scripts got this from the shell — `*.png` glob expansion is
 * byte-ordered, which is why png2mp4.sh has to demand zero-padded
 * `%05d` names. A numeric-aware collator doesn't care either way.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

export interface Picked {
  images: File[];
  /** Files that were in the folder but aren't images. Worth telling the user about. */
  skipped: number;
  /** Common leading directory, for a sensible default output name. */
  folder: string;
}

function relPath(f: File): string {
  return (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
}

export function pickFrames(files: File[]): Picked {
  const images = files.filter((f) => isImage(relPath(f)));
  images.sort((a, b) => naturalCompare(relPath(a), relPath(b)));
  const first = images[0] ? relPath(images[0]) : "";
  const folder = first.includes("/") ? first.split("/")[0] : "";
  return { images, skipped: files.length - images.length, folder };
}

/** Marks a file with the path it had inside the picked folder, for sorting. */
function withPath(file: File, path: string): File {
  Object.defineProperty(file, "webkitRelativePath", { value: path, configurable: true });
  return file;
}

/** The bits of File System Access we use; TS's DOM lib doesn't declare them. */
interface DirHandle {
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<[string, DirHandle | FileHandle]>;
}
interface FileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

/**
 * Pick a folder through File System Access, returning null if this browser
 * doesn't have it (caller falls back to `input[webkitdirectory]`) or undefined-ish
 * empty on cancel.
 *
 * Why not just the input: Chrome guards a directory input with a confirmation
 * that says *"要上传「x」中的所有文件吗?"*. Nothing is uploaded here — the files are
 * read, decoded and encoded in the page — and a prompt that claims otherwise is
 * worth some code to avoid. `showDirectoryPicker` asks to *view* files instead,
 * which is what actually happens.
 */
export async function pickDirectory(): Promise<File[] | null> {
  const picker = (window as unknown as {
    showDirectoryPicker?: (o?: { id?: string; mode?: string }) => Promise<DirHandle>;
  }).showDirectoryPicker;
  if (!picker) return null;

  let root: DirHandle;
  try {
    // `id` makes Chrome reopen where the user was last time.
    root = await picker.call(window, { id: "adbstudio-frames", mode: "read" });
  } catch {
    // Cancelled — an empty list, not a fallback to the other picker.
    return [];
  }

  const out: File[] = [];
  const walk = async (dir: DirHandle, prefix: string): Promise<void> => {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file") {
        out.push(withPath(await (handle as FileHandle).getFile(), prefix + name));
      } else {
        await walk(handle as DirHandle, `${prefix}${name}/`);
      }
    }
  };
  await walk(root, `${root.name}/`);
  return out;
}

/**
 * Walk a drop. `input[webkitdirectory]` hands over a flat FileList, but a
 * dragged folder arrives as entries that have to be recursed into.
 */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const roots = Array.from(dt.items)
    .map((i) => (i.kind === "file" ? i.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e !== null);

  if (roots.length === 0) return Array.from(dt.files);

  const out: File[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej),
      );
      // Preserve the path so sorting sees the same string the picker would give.
      out.push(withPath(file, prefix + file.name));
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries() returns at most ~100 per call and signals the end with an
    // empty batch — a folder of 300 frames needs the loop.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
        reader.readEntries(res, rej),
      );
      if (batch.length === 0) break;
      for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
    }
  };

  for (const r of roots) await walk(r, "");
  return out;
}

/**
 * Per-frame durations in milliseconds.
 *
 * Accumulated rather than a flat `1000/fps`: img2webp.sh's integer division
 * makes 30fps into 33ms, which runs 1% slow and drifts a whole second over a
 * 100-second animation. Rounding the *timeline* instead keeps the total honest,
 * at the cost of frames alternating between 33 and 34ms.
 */
export function frameDurations(count: number, fps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.round(((i + 1) * 1000) / fps) - Math.round((i * 1000) / fps));
  }
  return out;
}

/** Where a `sw`x`sh` image lands on a `dw`x`dh` canvas under the given fit. */
export function fitRect(
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  fit: Fit,
): { x: number; y: number; w: number; h: number } {
  if (fit === "stretch") return { x: 0, y: 0, w: dw, h: dh };
  const scale =
    fit === "cover" ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  return { x: Math.round((dw - w) / 2), y: Math.round((dh - h) / 2), w, h };
}

/** Rasterises each frame at a fixed size, reusing one canvas for the whole run. */
export class FrameCanvas {
  readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  private readonly fit: Fit;
  private readonly pad: string;

  // Fields spelled out rather than declared as constructor parameters: node's
  // type-stripping loader rejects parameter properties, and scripts/test-convert.mjs
  // imports this module directly.
  constructor(width: number, height: number, fit: Fit, pad: string) {
    this.width = width;
    this.height = height;
    this.fit = fit;
    this.pad = pad;
    this.canvas = new OffscreenCanvas(width, height);
    const ctx = this.canvas.getContext("2d", { alpha: true, willReadFrequently: true });
    if (!ctx) throw new Error("拿不到 2D 上下文");
    this.ctx = ctx;
    this.ctx.imageSmoothingQuality = "high";
  }

  draw(bitmap: ImageBitmap): void {
    const { ctx, width, height, pad } = this;
    ctx.clearRect(0, 0, width, height);
    if (pad !== "transparent") {
      ctx.fillStyle = pad;
      ctx.fillRect(0, 0, width, height);
    }
    const r = fitRect(bitmap.width, bitmap.height, width, height, this.fit);
    ctx.drawImage(bitmap, r.x, r.y, r.w, r.h);
  }

  pixels(): ImageData {
    return this.ctx.getImageData(0, 0, this.width, this.height);
  }
}

/** The canvas size a run should use, given the options and the first frame. */
export function targetSize(
  size: SizeOptions,
  first: { width: number; height: number },
  evenOnly: boolean,
): { width: number; height: number } {
  let w = size.mode === "custom" ? size.width : first.width;
  let h = size.mode === "custom" ? size.height : first.height;
  // H.264/HEVC/VP9 all encode 4:2:0 chroma, so odd dimensions either fail to
  // configure or get silently rounded by the encoder. Decide it here instead.
  if (evenOnly) {
    w -= w % 2;
    h -= h % 2;
  }
  return { width: Math.max(2, w), height: Math.max(2, h) };
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The rectangle in which `next` differs from `prev`, or null if they're
 * identical.
 *
 * x and y come back even because that's what ANMF can store (offsets are
 * halved), and the width/height are grown to match.
 */
export function diffBBox(
  prev: Uint8ClampedArray,
  next: Uint8ClampedArray,
  width: number,
  height: number,
): BBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  // 32-bit comparison: one read per pixel instead of four.
  const a = new Uint32Array(prev.buffer, prev.byteOffset, width * height);
  const b = new Uint32Array(next.buffer, next.byteOffset, width * height);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let rowMin = -1;
    let rowMax = -1;
    for (let x = 0; x < width; x++) {
      if (a[row + x] !== b[row + x]) {
        if (rowMin < 0) rowMin = x;
        rowMax = x;
      }
    }
    if (rowMin >= 0) {
      if (y < minY) minY = y;
      maxY = y;
      if (rowMin < minX) minX = rowMin;
      if (rowMax > maxX) maxX = rowMax;
    }
  }

  if (maxX < 0) return null;
  const x = minX & ~1;
  const y = minY & ~1;
  return { x, y, w: maxX - x + 1, h: maxY - y + 1 };
}
