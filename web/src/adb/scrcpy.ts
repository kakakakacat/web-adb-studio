// In-browser screen mirroring.
//
// The native app shelled out to a bundled scrcpy binary and let it open its own
// SDL window. Here we do what scrcpy's own client does, in the page: push
// scrcpy-server.jar to the device, start it over adb, and decode the H.264/H.265
// stream with WebCodecs onto a canvas. Touch/keyboard events go back through
// scrcpy's control channel.
//
// Version pinning matters: Tango's option definitions only go up to scrcpy
// server 3.3.3, so `scripts/fetch-assets.sh` downloads exactly that build into
// public/. A mismatched server rejects the option list and exits immediately.

import type { Adb } from "@yume-chan/adb";
import {
  AdbScrcpyClient,
  AdbScrcpyExitedError,
  AdbScrcpyOptionsLatest,
} from "@yume-chan/adb-scrcpy";
import {
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  AndroidScreenPowerMode,
  ScrcpyPointerId,
  type AndroidKeyCode,
  type AndroidKeyEventMeta,
  type ScrcpyMediaStreamPacket,
} from "@yume-chan/scrcpy";
import {
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
  BitmapVideoFrameRenderer,
  type VideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";

import type { ScrcpyOptions } from "../types";

/** Must match the version fetched by scripts/fetch-assets.sh. */
export const SCRCPY_SERVER_VERSION = "3.3.3";
const SCRCPY_SERVER_URL = "/scrcpy-server";
/** 宿主页面可以改这个地址：投屏挂件（embed-mirror.ts）被别的站点内联时，
 *  scrcpy-server 放在那个站点自己的源下（跨源取会被 CORS / 私有网络检查挡掉）。 */
export function setScrcpyServerUrl(url: string): void {
  serverUrl = url;
}
let serverUrl = SCRCPY_SERVER_URL;

/** Where scrcpy itself puts the server jar. */
const SERVER_PATH = "/data/local/tmp/scrcpy-server.jar";

export function webCodecsSupported(): boolean {
  return WebCodecsVideoDecoder.isSupported;
}

function createRenderer(canvas: HTMLCanvasElement): VideoFrameRenderer {
  // WebGL is the fast path; the bitmap renderer is a compatibility fallback
  // (it goes through createImageBitmap, which costs a copy per frame).
  //
  // `enableCapture: true` is needed for the snapshot button: without it WebGL
  // discards the drawing buffer after compositing, so `toBlob`/`drawImage` read
  // back a blank image even though the screen looks fine. It costs some
  // performance, which is the right trade for a tool that can grab frames.
  if (WebGLVideoFrameRenderer.isSupported) {
    return new WebGLVideoFrameRenderer(canvas, true);
  }
  return new BitmapVideoFrameRenderer(canvas);
}

export interface MirrorSession {
  /** Device screen size in pixels; needed to map canvas coords to touches. */
  width: number;
  height: number;
  onResize(cb: (width: number, height: number) => void): void;
  /** Forward a pointer event, given coordinates already in device pixels. */
  touch(action: number, x: number, y: number, pressure: number): Promise<void>;
  scroll(x: number, y: number, scrollX: number, scrollY: number): Promise<void>;
  keyCode(action: number, keyCode: number, metaState?: number): Promise<void>;
  /** Inject printable characters directly (ASCII-safe). */
  text(value: string): Promise<void>;
  /**
   * Set the device clipboard and optionally paste it.
   *
   * This is how non-ASCII text gets in: `injectText` goes through key events,
   * which can't express CJK, so anything beyond ASCII has to arrive via the
   * clipboard and a paste.
   */
  paste(value: string): Promise<void>;
  backOrScreenOn(): Promise<void>;
  rotate(): Promise<void>;
  snapshot(): Promise<Blob | undefined>;
  /** scrcpy server stdout/stderr, useful when a device refuses to start. */
  readonly log: readonly string[];
  stop(): Promise<void>;
}

export const MOTION = AndroidMotionEventAction;
export const KEY_ACTION = AndroidKeyEventAction;

/**
 * Start mirroring onto `canvas`. Resolves once the video stream is flowing.
 */
export async function startMirror(
  adb: Adb,
  canvas: HTMLCanvasElement,
  options: ScrcpyOptions,
  onLog?: (line: string) => void
): Promise<MirrorSession> {
  // 1. Push the server jar (fetched from our own origin, no CDN).
  const res = await fetch(serverUrl);
  if (!res.ok) {
    throw new Error(
      `缺少 scrcpy-server 资源（${res.status}）。请先运行 web/scripts/fetch-assets.sh。`
    );
  }
  const serverBytes = new Uint8Array(await res.arrayBuffer());
  await AdbScrcpyClient.pushServer(
    adb,
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(serverBytes);
        controller.close();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
    SERVER_PATH
  );

  // 2. Start it.
  //
  // `tunnelForward: true` is required, not an optimisation. By default scrcpy
  // uses a *reverse* tunnel: the server on the device connects back to the
  // client, which means the client has to listen on a socket. A browser cannot
  // listen, so the reverse path is unavailable on both our transports — over the
  // relay `addReverseTunnel` throws outright. With a forward tunnel we dial the
  // device's localabstract socket instead, which is something both transports
  // can do. (Tango does not fall back on its own.)
  //
  // `video: true` also keeps the videoStream type non-undefined.
  const scrcpyOptions = new AdbScrcpyOptionsLatest({
    video: true,
    audio: false, // audio needs a separate decoder; not wired up yet
    control: true,
    tunnelForward: true,
    maxSize: options.maxSize,
    maxFps: options.maxFps,
    stayAwake: options.stayAwake,
    showTouches: options.showTouches,
    videoCodec: "h264",
  });

  const client = await AdbScrcpyClient.start(adb, SERVER_PATH, scrcpyOptions);

  const log: string[] = [];
  void (async () => {
    try {
      for await (const line of client.output) {
        log.push(line);
        onLog?.(line);
      }
    } catch {
      /* stream closed with the client */
    }
  })();

  const videoStream = await client.videoStream;
  if (!videoStream) throw new Error("scrcpy 未返回视频流");

  // 3. Decode into the canvas.
  const decoder = new WebCodecsVideoDecoder({
    codec: videoStream.metadata.codec,
    renderer: createRenderer(canvas),
  });

  const resizeCallbacks: ((w: number, h: number) => void)[] = [];
  let width = videoStream.width;
  let height = videoStream.height;
  videoStream.sizeChanged(({ width: w, height: h }) => {
    width = w;
    height = h;
    for (const cb of resizeCallbacks) cb(w, h);
  });

  void (videoStream.stream as unknown as ReadableStream<ScrcpyMediaStreamPacket>)
    .pipeTo(decoder.writable as unknown as WritableStream<ScrcpyMediaStreamPacket>)
    .catch(() => {
      /* ends when mirroring stops */
    });

  const controller = client.controller;
  if (options.turnScreenOff) {
    // scrcpy's --turn-screen-off is a control message, not a server option.
    await controller?.setScreenPowerMode(AndroidScreenPowerMode.Off);
  }

  let stopped = false;

  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    onResize(cb) {
      resizeCallbacks.push(cb);
    },
    async touch(action, x, y, pressure) {
      await controller?.injectTouch({
        action: action as AndroidMotionEventAction,
        pointerId: ScrcpyPointerId.Finger,
        pointerX: Math.round(x),
        pointerY: Math.round(y),
        pressure,
        actionButton: AndroidMotionEventButton.Primary,
        buttons: action === MOTION.Up ? 0 : AndroidMotionEventButton.Primary,
        // scrcpy scales coordinates against the *video* size it is streaming,
        // which is what the decoder reports — not the physical screen size.
        videoWidth: width,
        videoHeight: height,
      });
    },
    async scroll(x, y, scrollX, scrollY) {
      await controller?.injectScroll({
        pointerX: Math.round(x),
        pointerY: Math.round(y),
        scrollX,
        scrollY,
        buttons: 0,
        videoWidth: width,
        videoHeight: height,
      });
    },
    async keyCode(action, keyCode, metaState = 0) {
      await controller?.injectKeyCode({
        action: action as AndroidKeyEventAction,
        // The UI passes raw Android keycodes (the same integers `input keyevent`
        // takes); the enum is just a named subset of those.
        keyCode: keyCode as AndroidKeyCode,
        repeat: 0,
        // The caller passes an OR of Android meta bits (see adb/keymap.ts).
        metaState: metaState as AndroidKeyEventMeta,
      });
    },
    async text(value) {
      await controller?.injectText(value);
    },
    async paste(value) {
      // sequence 0n = don't ask the device to acknowledge; we don't track acks.
      await controller?.setClipboard({ sequence: 0n, content: value, paste: true });
    },
    async backOrScreenOn() {
      await controller?.backOrScreenOn(AndroidKeyEventAction.Down);
      await controller?.backOrScreenOn(AndroidKeyEventAction.Up);
    },
    async rotate() {
      await controller?.rotateDevice();
    },
    snapshot() {
      return decoder.snapshot();
    },
    get log() {
      return log;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      // Restore the screen if we turned it off, otherwise the device is left dark.
      if (options.turnScreenOff) {
        try {
          await controller?.setScreenPowerMode(AndroidScreenPowerMode.Normal);
        } catch {
          /* device already gone */
        }
      }
      decoder.dispose();
      try {
        await client.close();
      } catch (e) {
        if (!(e instanceof AdbScrcpyExitedError)) throw e;
      }
    },
  };
}
