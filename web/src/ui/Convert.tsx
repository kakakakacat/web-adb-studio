// 图片序列 → 动图 WebP / MP4.
//
// The one page here that has nothing to do with a device: it needs no adb
// connection and shows up whether or not a phone is plugged in. It's here
// because the assets it produces are the ones you then push to a device, and
// because everything it needs — image decoding, libwebp (wasm), a video encoder
// — the browser already has.
//
// Parameter defaults mirror scripts/img2webp.sh and scripts/png2mp4.sh, so the
// page and the shell produce comparable output.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { probeCodecs } from "../media/encode-mp4";
import { filesFromDataTransfer, pickDirectory, pickFrames } from "../media/frames";
import {
  DEFAULT_OPTIONS,
  type JobOptions,
  type Mp4Codec,
  type WorkerOut,
} from "../media/types";
import { useStore } from "../store";
import { Icon } from "./Icon";

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const CODEC_LABEL: Record<Mp4Codec, string> = {
  avc: "H.264 / AVC",
  hevc: "H.265 / HEVC",
  vp9: "VP9",
  av1: "AV1",
};

interface Source {
  files: File[];
  skipped: number;
  folder: string;
  first: { width: number; height: number };
  /** Object URL of the first image, so the picker shows what it picked up. */
  thumb: string;
}

interface Result {
  url: string;
  mime: string;
  bytes: number;
  frames: number;
  width: number;
  height: number;
  durationMs: number;
}

/**
 * A labelled control, with the parameter's explanation behind a "?".
 *
 * The bubble is `position: fixed` and placed from the icon's measured rect rather
 * than being an absolutely-positioned child. Inside the panel it would be at the
 * mercy of whichever ancestor scrolls or clips — and these explanations are two
 * lines of ffmpeg equivalence, i.e. exactly the size that gets cut off. Fixed
 * coordinates also make it trivial to keep the bubble inside the window.
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  const show = (e: React.SyntheticEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const half = 150;
    setAt({
      x: Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8),
      y: r.bottom + 8,
    });
  };

  return (
    <label className="field">
      <span className="fl">
        {label}
        {hint && (
          // Focusable so the explanation isn't mouse-only.
          <em
            tabIndex={0}
            aria-label={hint}
            onPointerEnter={show}
            onPointerLeave={() => setAt(null)}
            onFocus={show}
            onBlur={() => setAt(null)}
          >
            ?
            {at && (
              <span className="tip" role="tooltip" style={{ left: at.x, top: at.y }}>
                {hint}
              </span>
            )}
          </em>
        )}
      </span>
      {children}
    </label>
  );
}

export function Convert() {
  const toast = useStore((s) => s.toast);
  const [src, setSrc] = useState<Source | null>(null);
  const [opts, setOpts] = useState<JobOptions>(DEFAULT_OPTIONS);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [codecs, setCodecs] = useState<Mp4Codec[] | null>(null);
  const [name, setName] = useState("");
  // Preview state. `replays` only exists to give the media element a new key.
  const [zoom, setZoom] = useState<"fit" | "actual">("fit");
  const [checker, setChecker] = useState(true);
  const [replays, setReplays] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const worker = useRef<Worker | null>(null);
  const lastUrl = useRef<string | null>(null);
  const thumbUrl = useRef<string | null>(null);

  const replay = useCallback(() => setReplays((n) => n + 1), []);

  const patch = useCallback((p: Partial<JobOptions>) => setOpts((o) => ({ ...o, ...p })), []);

  // Blob URLs outlive the component unless revoked, and each result here is a
  // whole animation.
  useEffect(
    () => () => {
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
      if (thumbUrl.current) URL.revokeObjectURL(thumbUrl.current);
      worker.current?.terminate();
    },
    [],
  );

  const load = useCallback(
    async (list: File[]) => {
      const picked = pickFrames(list);
      if (picked.images.length === 0) {
        toast("error", "没找到 png / jpg 图片");
        return;
      }
      let first: { width: number; height: number };
      try {
        const bitmap = await createImageBitmap(picked.images[0]);
        first = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
      } catch {
        toast("error", `第一张「${picked.images[0].name}」解不开`);
        return;
      }
      if (thumbUrl.current) URL.revokeObjectURL(thumbUrl.current);
      thumbUrl.current = URL.createObjectURL(picked.images[0]);
      setSrc({
        files: picked.images,
        skipped: picked.skipped,
        folder: picked.folder,
        first,
        thumb: thumbUrl.current,
      });
      setName(picked.folder || "output");
      setResult(null);
    },
    [toast],
  );

  // Folder picking, preferring the API that doesn't claim to upload anything.
  // The hidden directory input stays as the fallback for browsers without File
  // System Access.
  const chooseFolder = useCallback(async () => {
    const files = await pickDirectory();
    if (files === null) input.current?.click();
    else if (files.length > 0) await load(files);
  }, [load]);

  // The size the run will actually use — shown next to the inputs so "原始尺寸"
  // and the even-number rounding for video aren't a surprise.
  const out = useMemo(() => {
    if (!src) return null;
    const raw = {
      w: opts.size.mode === "custom" ? opts.size.width : src.first.width,
      h: opts.size.mode === "custom" ? opts.size.height : src.first.height,
    };
    const even = opts.format === "mp4";
    const w = even ? raw.w - (raw.w % 2) : raw.w;
    const h = even ? raw.h - (raw.h % 2) : raw.h;
    const frames = Math.ceil(src.files.length / Math.max(1, opts.step));
    return {
      width: Math.max(2, w),
      height: Math.max(2, h),
      frames,
      rounded: w !== raw.w || h !== raw.h,
    };
  }, [src, opts.size, opts.format, opts.step]);

  // Which codecs this machine can encode depends on the resolution, so re-probe
  // whenever it changes rather than once at load.
  useEffect(() => {
    if (opts.format !== "mp4" || !out) return;
    let live = true;
    void probeCodecs(out.width, out.height, opts.fps).then((probes) => {
      if (!live) return;
      const ok = probes.filter((p) => p.supported).map((p) => p.codec);
      setCodecs(ok);
      // Don't leave a codec selected that this machine can't produce.
      if (ok.length > 0 && !ok.includes(opts.mp4.codec)) {
        setOpts((o) => ({ ...o, mp4: { ...o.mp4, codec: ok[0] } }));
      }
    });
    return () => {
      live = false;
    };
  }, [opts.format, opts.fps, opts.mp4.codec, out?.width, out?.height]);

  const start = useCallback(() => {
    if (!src) return;
    setResult(null);
    setProgress({ done: 0, total: out?.frames ?? src.files.length });

    const w = new Worker(new URL("../media/worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    const started = performance.now();

    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      if (msg.type === "progress") {
        setProgress({ done: msg.done, total: msg.total });
        return;
      }
      w.terminate();
      worker.current = null;
      setProgress(null);
      if (msg.type === "error") {
        toast("error", msg.message);
        return;
      }
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
      const blob = new Blob([msg.buffer], { type: msg.mime });
      lastUrl.current = URL.createObjectURL(blob);
      setResult({
        url: lastUrl.current,
        mime: msg.mime,
        bytes: blob.size,
        frames: msg.frames,
        width: msg.width,
        height: msg.height,
        durationMs: msg.durationMs,
      });
      toast(
        "success",
        `完成：${msg.frames} 帧 ${human(blob.size)}，用了 ${((performance.now() - started) / 1000).toFixed(1)}s`,
      );
    };
    w.onerror = (e) => {
      w.terminate();
      worker.current = null;
      setProgress(null);
      toast("error", `转换失败：${e.message}`);
    };
    w.postMessage({ files: src.files, opts });
  }, [src, opts, out, toast]);

  const cancel = useCallback(() => {
    worker.current?.terminate();
    worker.current = null;
    setProgress(null);
  }, []);

  const ext = opts.format === "webp" ? "webp" : "mp4";
  const fileName = `${(name || "output").replace(/\.(webp|mp4)$/i, "")}.${ext}`;

  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.1fr)" }}>
      <div className="stack">
        <div className="card">
          <h3>图片序列</h3>
          <div
            className={`drop ${over ? "over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void filesFromDataTransfer(e.dataTransfer).then(load);
            }}
            onClick={() => void chooseFolder()}
          >
            <Icon name="image" />
            <span className="big">把图片文件夹拖到这里</span>
            <span style={{ fontSize: 12 }}>或点击选择整个文件夹 · png / jpg · 不会上传</span>
            <input
              ref={input}
              type="file"
              hidden
              multiple
              // Not a standard attribute, but the only way to get a whole folder
              // out of a file input. React passes unknown lowercase props through.
              {...{ webkitdirectory: "" }}
              onChange={(e) => {
                void load([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </div>

          {/* A directory input cannot select loose files, so frames that aren't in
              a folder of their own would otherwise be unreachable. */}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn sm ghost" onClick={() => picker.current?.click()}>
              <Icon name="file" />
              选择单张 / 多张图片
            </button>
            <input
              ref={picker}
              type="file"
              hidden
              multiple
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                void load([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </div>

          {src && (
            <div className="row" style={{ marginTop: 14, alignItems: "flex-start" }}>
              <div className="preview checker" style={{ width: 132, minHeight: 0, flex: "none" }}>
                <img src={src.thumb} alt="首帧" />
              </div>
              <div className="muted" style={{ fontSize: 12, flex: 1, lineHeight: 1.7 }}>
                首帧：<span className="mono">{src.files[0].name}</span>
                <br />
                末帧：<span className="mono">{src.files[src.files.length - 1].name}</span>
                <br />
                按文件名自然序排列（<span className="mono">frame_2</span> 在{" "}
                <span className="mono">frame_10</span> 前面，不必补零）
                {src.skipped > 0 && (
                  <>
                    <br />
                    忽略了 {src.skipped} 个非图片文件
                  </>
                )}
              </div>
            </div>
          )}

          {src && (
            <div className="stats" style={{ marginTop: 14 }}>
              <div className="stat">
                <div className="k">图片</div>
                <div className="v">{src.files.length}</div>
              </div>
              <div className="stat">
                <div className="k">首帧尺寸</div>
                <div className="v">
                  {src.first.width}×{src.first.height}
                </div>
              </div>
              <div className="stat">
                <div className="k">时长</div>
                <div className="v">
                  {((out?.frames ?? 0) / Math.max(1, opts.fps)).toFixed(1)}s
                </div>
              </div>
            </div>
          )}

        </div>

        <div className="card">
          <h3>输出</h3>
          <div className="row" style={{ marginBottom: 14 }}>
            <div className="tabs">
              {(["webp", "mp4"] as const).map((f) => (
                <button
                  key={f}
                  className={`tab ${opts.format === f ? "on" : ""}`}
                  onClick={() => patch({ format: f })}
                >
                  {f === "webp" ? "动图 WebP" : "MP4 视频"}
                </button>
              ))}
            </div>
          </div>

          <div className="fields">
            <Field label="帧率 fps">
              <input
                type="number"
                min={1}
                max={120}
                value={opts.fps}
                onChange={(e) => patch({ fps: Number(e.target.value) || 1 })}
              />
            </Field>
            <Field label="抽帧" hint="每 N 张取 1 张。2 就是丢掉一半帧。">
              <input
                type="number"
                min={1}
                max={20}
                value={opts.step}
                onChange={(e) => patch({ step: Math.max(1, Number(e.target.value) || 1) })}
              />
            </Field>
            <Field label="尺寸">
              <select
                value={opts.size.mode}
                onChange={(e) =>
                  patch({ size: { ...opts.size, mode: e.target.value as "original" | "custom" } })
                }
              >
                <option value="original">跟首帧一致</option>
                <option value="custom">指定</option>
              </select>
            </Field>
            {opts.size.mode === "custom" && (
              <>
                <Field label="宽">
                  <input
                    type="number"
                    min={2}
                    value={opts.size.width}
                    onChange={(e) =>
                      patch({ size: { ...opts.size, width: Number(e.target.value) || 2 } })
                    }
                  />
                </Field>
                <Field label="高">
                  <input
                    type="number"
                    min={2}
                    value={opts.size.height}
                    onChange={(e) =>
                      patch({ size: { ...opts.size, height: Number(e.target.value) || 2 } })
                    }
                  />
                </Field>
              </>
            )}
            <Field
              label="缩放"
              hint="包含 = 等比缩到放得下、四周留边（等于 png2mp4.sh 的 decrease + pad）；填充 = 等比放大铺满、裁掉溢出；拉伸 = 不管比例。"
            >
              <select
                value={opts.size.fit}
                onChange={(e) =>
                  patch({ size: { ...opts.size, fit: e.target.value as typeof opts.size.fit } })
                }
              >
                <option value="contain">包含并留边</option>
                <option value="cover">填充并裁切</option>
                <option value="stretch">拉伸</option>
              </select>
            </Field>
            <Field label="留边颜色">
              <select
                value={opts.size.pad}
                onChange={(e) => patch({ size: { ...opts.size, pad: e.target.value } })}
              >
                <option value="#000000">黑</option>
                <option value="#ffffff">白</option>
                <option value="transparent">透明（仅 WebP）</option>
              </select>
            </Field>
            <Field label="文件名">
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>

          {out && (
            <p className="muted" style={{ fontSize: 12, margin: "12px 0 0" }}>
              实际输出 <span className="mono">{out.width}×{out.height}</span> · {out.frames} 帧
              {out.rounded && " · 尺寸已向下取偶（H.264/HEVC 的 4:2:0 色度要求）"}
              {opts.format === "mp4" && opts.size.pad === "transparent" && " · MP4 没有透明通道，留边会是黑色"}
            </p>
          )}
        </div>
      </div>

      <div className="stack">
        <div className="card">
          <h3>{opts.format === "webp" ? "WebP 参数（libwebp）" : "视频参数（WebCodecs）"}</h3>

          {opts.format === "webp" ? (
            <>
              <div className="fields">
                <Field
                  label="无损"
                  hint="默认有损，画质由下面的 q 控制。切到无损（img2webp -lossless）体积通常大好几倍，值得的场合是像素画、纯色图标这类有大片相同像素的素材。"
                >
                  <select
                    value={opts.webp.lossless ? "1" : "0"}
                    onChange={(e) =>
                      patch({ webp: { ...opts.webp, lossless: e.target.value === "1" } })
                    }
                  >
                    <option value="1">无损</option>
                    <option value="0">有损</option>
                  </select>
                </Field>
                <Field
                  label={opts.webp.lossless ? "压缩力度 q" : "质量 q"}
                  hint="有损时是画质；无损时 libwebp 拿它权衡压缩耗时与体积。"
                >
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={opts.webp.quality}
                    onChange={(e) =>
                      patch({ webp: { ...opts.webp, quality: Number(e.target.value) || 0 } })
                    }
                  />
                </Field>
                <Field label="method -m" hint="0 最快、6 最小。脚本里用的是 4。">
                  <input
                    type="number"
                    min={0}
                    max={6}
                    value={opts.webp.method}
                    onChange={(e) =>
                      patch({ webp: { ...opts.webp, method: Number(e.target.value) || 0 } })
                    }
                  />
                </Field>
                <Field
                  label="near_lossless"
                  hint="仅无损模式有效。100 = 关闭；调低会先做一次视觉无损量化再无损编码，体积明显小。"
                >
                  <input
                    type="number"
                    min={0}
                    max={100}
                    disabled={!opts.webp.lossless}
                    value={opts.webp.nearLossless}
                    onChange={(e) =>
                      patch({ webp: { ...opts.webp, nearLossless: Number(e.target.value) || 0 } })
                    }
                  />
                </Field>
                <Field label="循环次数" hint="0 = 无限循环。">
                  <input
                    type="number"
                    min={0}
                    max={65535}
                    value={opts.webp.loop}
                    onChange={(e) =>
                      patch({ webp: { ...opts.webp, loop: Number(e.target.value) || 0 } })
                    }
                  />
                </Field>
              </div>

              <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={opts.webp.diff}
                    onChange={(e) => patch({ webp: { ...opts.webp, diff: e.target.checked } })}
                  />
                  跨帧差分
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={opts.webp.exact}
                    onChange={(e) => patch({ webp: { ...opts.webp, exact: e.target.checked } })}
                  />
                  exact（保留全透明像素的 RGB）
                </label>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: "12px 0 0" }}>
                跨帧差分只编码相对上一帧变化的那块矩形，完全没变的帧直接并进前一帧的时长。
                背景静止的动画能小一个数量级；每帧整幅都在变（如实拍、噪点）时没有收益，
                可以关掉省一次逐像素比较。
              </p>
            </>
          ) : (
            <>
              <div className="fields">
                <Field label="编码器">
                  <select
                    value={opts.mp4.codec}
                    onChange={(e) =>
                      patch({ mp4: { ...opts.mp4, codec: e.target.value as Mp4Codec } })
                    }
                  >
                    {(codecs ?? (["avc"] as Mp4Codec[])).map((c) => (
                      <option key={c} value={c}>
                        {CODEC_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="码率 Mbps"
                  hint="WebCodecs 没有 CRF，只能给目标码率。1200x1920@20fps 想接近 png2mp4.sh 的 crf 33，大约 6–10 Mbps。"
                >
                  <input
                    type="number"
                    min={0.2}
                    max={200}
                    step={0.5}
                    value={opts.mp4.bitrateMbps}
                    onChange={(e) =>
                      patch({ mp4: { ...opts.mp4, bitrateMbps: Number(e.target.value) || 1 } })
                    }
                  />
                </Field>
                <Field label="关键帧间隔（秒）">
                  <input
                    type="number"
                    min={0.1}
                    max={30}
                    step={0.1}
                    value={opts.mp4.keyframeSec}
                    onChange={(e) =>
                      patch({ mp4: { ...opts.mp4, keyframeSec: Number(e.target.value) || 1 } })
                    }
                  />
                </Field>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: "12px 0 0" }}>
                编码器列表是在这台机器上探测出来的（<span className="mono">isConfigSupported</span>），
                能力取决于系统和显卡 —— HEVC 在 macOS 上一般有，Linux 上通常没有。
                编码走硬件，几百帧是秒级。
              </p>
            </>
          )}
        </div>

        <div className="card">
          <h3>开始</h3>
          <div className="row">
            {progress ? (
              <button className="btn danger" onClick={cancel}>
                <Icon name="stop" />
                取消
              </button>
            ) : (
              <button className="btn primary" disabled={!src} onClick={start}>
                <Icon name="play" />
                开始转换
              </button>
            )}
            {result && (
              <>
                {/* Opening the blob in a tab is the honest preview: it's the
                    browser's own decoder on the real file, not our canvas. */}
                <a
                  className="btn"
                  href={result.url}
                  target="_blank"
                  rel="noreferrer"
                  title="用浏览器打开产物（新标签页）"
                >
                  <Icon name="eye" />
                  在浏览器中打开
                </a>
                <a className="btn ghost" href={result.url} download={fileName}>
                  <Icon name="download" />
                  下载 {fileName}
                </a>
              </>
            )}
          </div>

          {progress && (
            <div style={{ marginTop: 14 }}>
              <div className="bar">
                <i style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {progress.done} / {progress.total} 帧
              </div>
            </div>
          )}

          {!result && !progress && (
            <p className="muted" style={{ fontSize: 12, margin: "12px 0 0" }}>
              全程在这个页面里完成 —— 图片不上传，也不需要装 ffmpeg 或 libwebp。
            </p>
          )}
        </div>

        {result && (
          <div className="card">
            <div className="row" style={{ marginBottom: 12 }}>
              <h3 style={{ margin: 0, flex: 1 }}>预览</h3>
              <button className="btn sm ghost" onClick={replay} title="从第一帧重新播放">
                <Icon name="restart" />
                重播
              </button>
              <button
                className={`btn sm ${zoom === "actual" ? "" : "ghost"}`}
                onClick={() => setZoom((z) => (z === "fit" ? "actual" : "fit"))}
                title="在「缩放到框内」和「像素 1:1」之间切换"
              >
                {zoom === "fit" ? "适应" : "1:1"}
              </button>
              <label className="check">
                <input
                  type="checkbox"
                  checked={checker}
                  onChange={(e) => setChecker(e.target.checked)}
                />
                棋盘格
              </label>
            </div>

            {/* Keyed so 重播 remounts the element: re-assigning the same blob URL
                does not reliably restart an animated WebP. */}
            {result.mime === "image/webp" ? (
              // The whole box is a link: clicking the animation opens the real
              // file in a tab, which is where you'd check it against a browser
              // that isn't ours.
              <a
                className={`preview ${checker ? "checker" : ""} ${zoom}`}
                href={result.url}
                target="_blank"
                rel="noreferrer"
                title="点击用浏览器打开"
              >
                <img key={replays} data-role="out" src={result.url} alt="转换结果预览" />
              </a>
            ) : (
              // Not a link — the video's own controls live inside it.
              <div className={`preview ${checker ? "checker" : ""} ${zoom}`}>
                <video
                  key={replays}
                  ref={video}
                  data-role="out"
                  src={result.url}
                  autoPlay
                  loop
                  muted
                  controls
                />
              </div>
            )}

            <div className="stats" style={{ marginTop: 14 }}>
              <div className="stat">
                <div className="k">体积</div>
                <div className="v">{human(result.bytes)}</div>
              </div>
              <div className="stat">
                <div className="k">尺寸</div>
                <div className="v">
                  {result.width}×{result.height}
                </div>
              </div>
              <div className="stat">
                <div className="k">帧数</div>
                <div className="v">{result.frames}</div>
              </div>
              <div className="stat">
                <div className="k">时长</div>
                <div className="v">{(result.durationMs / 1000).toFixed(1)}s</div>
              </div>
            </div>

            <p className="muted" style={{ fontSize: 12, margin: "12px 0 0" }}>
              {result.mime === "image/webp"
                ? "预览就是浏览器自己在解这个 webp —— 循环次数、每帧时长都按产物里写的走，和设备上看到的一致。"
                : `平均码率 ${((result.bytes * 8) / Math.max(1, result.durationMs / 1000) / 1e6).toFixed(1)} Mbps。`}
              {result.mime === "image/webp" &&
                result.frames < (out?.frames ?? 0) &&
                ` ${(out?.frames ?? 0) - result.frames} 帧和前一帧完全相同，已并进前一帧的时长，播放速度不变。`}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
