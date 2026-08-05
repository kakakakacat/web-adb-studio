// Screen mirroring. The canvas maps pointer events back to device coordinates
// and forwards them over scrcpy's control channel, so the screen is interactive.

import { useEffect, useRef, useState } from "react";

import { KEY_CODES, isPrintableAscii, metaStateOf } from "../adb/keymap";
import { KEYCODES } from "../adb/media";
import { MOTION, startMirror, webCodecsSupported, type MirrorSession } from "../adb/scrcpy";
import { useStore, type Active } from "../store";
import { DEFAULT_SCRCPY_OPTIONS, errorMessage, type ScrcpyOptions } from "../types";
import { Icon } from "./Icon";

export function Mirror({ active }: { active: Active }) {
  const toast = useStore((s) => s.toast);
  const liveAdb = useStore((s) => s.liveAdb);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<MirrorSession | null>(null);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [options, setOptions] = useState<ScrcpyOptions>(DEFAULT_SCRCPY_OPTIONS);
  const [log, setLog] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [kbd, setKbd] = useState(true);

  // Always tear the session down when leaving the tab or swapping devices —
  // otherwise scrcpy keeps running on the device and the screen stays awake.
  useEffect(() => {
    return () => {
      const s = sessionRef.current;
      sessionRef.current = null;
      if (s) void s.stop();
    };
  }, [active.adb]);

  async function start() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setStarting(true);
    setLog([]);
    try {
      // Not `active.adb` directly: unplugging and replugging leaves that object
      // pointing at a transport the adb server has already forgotten, and the
      // failure surfaced here as "no device with transport id '6'" — an id the
      // person holding the cable can do nothing with. Ask the store for one that
      // has just answered, which reconnects when it hasn't.
      const adb = await liveAdb("投屏");
      const session = await startMirror(adb, canvas, options, (line) =>
        setLog((prev) => [...prev.slice(-40), line])
      );
      // A reconnect swaps the store's `Adb`, and this component tears its session
      // down whenever that happens. If that already fired, the session we just
      // built belongs to nobody.
      if (useStore.getState().active?.adb !== adb) {
        void session.stop();
        return;
      }
      sessionRef.current = session;
      setRunning(true);
    } catch (e) {
      toast("error", `投屏启动失败：${errorMessage(e)}`);
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    const s = sessionRef.current;
    sessionRef.current = null;
    setRunning(false);
    if (s) await s.stop();
  }

  /**
   * Send a browser key event to the device.
   *
   * Printable ASCII goes as text — expressing it as keycodes would mean
   * reimplementing a keyboard layout. Everything else maps to an Android keycode.
   * Anything non-ASCII (CJK) can't travel either way and goes via the clipboard,
   * which is what the text box below does.
   */
  async function onKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
    const session = sessionRef.current;
    if (!session || !kbd) return;

    // Let the browser keep its own shortcuts (copy, reload, devtools).
    if (e.metaKey || (e.ctrlKey && !["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key))) {
      return;
    }
    e.preventDefault();

    try {
      const mapped = KEY_CODES[e.key] ?? KEY_CODES[e.code];
      if (mapped !== undefined) {
        const meta = metaStateOf(e);
        await session.keyCode(0, mapped, meta);
        await session.keyCode(1, mapped, meta);
        return;
      }
      if (isPrintableAscii(e.key)) {
        await session.text(e.key);
        return;
      }
      // Non-ASCII from a physical keyboard / IME composition result.
      if (e.key.length === 1) await session.paste(e.key);
    } catch {
      /* device went away mid-keystroke */
    }
  }

  /** Canvas pixel position for a pointer event, in device coordinates. */
  function devicePoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    // The canvas is letterboxed by CSS `max-width/max-height`, so scale from the
    // displayed box to the backing store, which is the device resolution.
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    return { x, y };
  }

  function onPointer(action: number) {
    return (e: React.PointerEvent<HTMLCanvasElement>) => {
      const session = sessionRef.current;
      if (!session) return;
      if (action === MOTION.Move && e.buttons === 0) return; // hover, not a drag
      e.preventDefault();
      const { x, y } = devicePoint(e);
      void session.touch(action, x, y, action === MOTION.Up ? 0 : 1).catch(() => {});
    };
  }

  async function key(code: number) {
    const session = sessionRef.current;
    if (!session) return;
    try {
      await session.keyCode(0, code); // Down
      await session.keyCode(1, code); // Up
    } catch (e) {
      toast("error", errorMessage(e));
    }
  }

  if (!webCodecsSupported()) {
    return (
      <div className="card">
        <h3>投屏</h3>
        <p className="muted">
          当前浏览器不支持 WebCodecs，无法在网页里解码视频。请使用较新的 Chrome / Edge。
        </p>
      </div>
    );
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(260px, 1fr)" }}>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>投屏</h3>
          <div className="row">
            {running ? (
              <>
                <button className="btn sm" onClick={() => void sessionRef.current?.rotate()}>
                  旋转
                </button>
                <button
                  className="btn sm"
                  onClick={() =>
                    void sessionRef.current?.snapshot().then((blob) => {
                      if (!blob) return;
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "screen.png";
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 0);
                    })
                  }
                >
                  抓帧
                </button>
                <button className="btn sm danger" onClick={() => void stop()}>
                  停止
                </button>
              </>
            ) : (
              <button className="btn primary" disabled={starting} onClick={() => void start()}>
                {starting ? "启动中…" : "开始投屏"}
              </button>
            )}
          </div>
        </div>

        <div className="screen">
          <canvas
            ref={canvasRef}
            // Focusable so it can receive key events at all.
            tabIndex={0}
            onKeyDown={(e) => void onKeyDown(e)}
            onPointerDown={onPointer(MOTION.Down)}
            onPointerMove={onPointer(MOTION.Move)}
            onPointerUp={onPointer(MOTION.Up)}
            onPointerCancel={onPointer(MOTION.Up)}
            onWheel={(e) => {
              const session = sessionRef.current;
              if (!session) return;
              e.preventDefault();
              const canvas = e.currentTarget;
              const rect = canvas.getBoundingClientRect();
              const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
              const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
              // scrcpy wants -1..1; a wheel notch is ~100px.
              void session
                .scroll(x, y, -e.deltaX / 100, -e.deltaY / 100)
                .catch(() => {});
            }}
          />
        </div>

        {running && (
          <div className="row" style={{ marginTop: 12 }}>
            <input
              type="text"
              style={{ flex: 1, minWidth: 160 }}
              placeholder="输入文本（支持中文，走剪贴板粘贴）"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !text) return;
                e.preventDefault();
                void sessionRef.current
                  ?.paste(text)
                  .then(() => setText(""))
                  .catch((err) => toast("error", errorMessage(err)));
              }}
            />
            <button
              className="btn sm primary"
              disabled={!text}
              onClick={() =>
                void sessionRef.current
                  ?.paste(text)
                  .then(() => setText(""))
                  .catch((err) => toast("error", errorMessage(err)))
              }
            >
              <Icon name="send" />
              发送
            </button>
            <label className="check" title="点击画面后可直接用物理键盘输入">
              <input type="checkbox" checked={kbd} onChange={(e) => setKbd(e.target.checked)} />
              键盘
            </label>
          </div>
        )}

        {running && (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={() => void sessionRef.current?.backOrScreenOn()}>
              返回 / 亮屏
            </button>
            <button className="btn sm" onClick={() => void key(KEYCODES.home)}>
              主屏
            </button>
            <button className="btn sm" onClick={() => void key(KEYCODES.appSwitch)}>
              任务
            </button>
            <button className="btn sm" onClick={() => void key(KEYCODES.volumeUp)}>
              音量+
            </button>
            <button className="btn sm" onClick={() => void key(KEYCODES.volumeDown)}>
              音量−
            </button>
            <button className="btn sm" onClick={() => void key(KEYCODES.power)}>
              电源
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h3>参数</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          修改后需重新开始投屏才会生效。
        </p>
        <div style={{ display: "grid", gap: 10 }}>
          <label>
            <div className="muted">最大边长：{options.maxSize}px</div>
            <input
              type="range"
              min={480}
              max={2560}
              step={80}
              value={options.maxSize}
              disabled={running}
              style={{ width: "100%" }}
              onChange={(e) => setOptions({ ...options, maxSize: Number(e.target.value) })}
            />
          </label>
          <label>
            <div className="muted">最大帧率：{options.maxFps}</div>
            <input
              type="range"
              min={15}
              max={120}
              step={5}
              value={options.maxFps}
              disabled={running}
              style={{ width: "100%" }}
              onChange={(e) => setOptions({ ...options, maxFps: Number(e.target.value) })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={options.stayAwake}
              disabled={running}
              onChange={(e) => setOptions({ ...options, stayAwake: e.target.checked })}
            />
            保持唤醒
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={options.showTouches}
              disabled={running}
              onChange={(e) => setOptions({ ...options, showTouches: e.target.checked })}
            />
            显示触摸点
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={options.turnScreenOff}
              disabled={running}
              onChange={(e) => setOptions({ ...options, turnScreenOff: e.target.checked })}
            />
            投屏时关闭设备屏幕
          </label>
        </div>

        {log.length > 0 && (
          <pre className="log" style={{ marginTop: 12 }}>
            {log.join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}
