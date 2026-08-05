// Live network capture from the app's in-process collector.
//
// There is no HTTP server on the device and no `adb forward` in sight: the app
// binds an *abstract* LocalSocket and we open it straight through the adb
// connection we already have. That matters because in WebUSB mode there is no adb
// server on this machine to forward anything, and it means the device never opens
// a TCP port — nothing to secure, nothing to leak.
//
// Both transports (WebUSB and the bridged adb server) hand us the same `Adb`, so
// this one implementation covers both.
//
// Frame format, matching CommonCore/src/debug/.../Frame.kt:
//
//   u32be payloadLen | u8 type | payload
//
//   type 1 EVENT    UTF-8 JSON
//   type 2 BLOB     u16be refLen | ref | i32be truncatedFrom | bytes
//   type 3 CONTROL  UTF-8 JSON, both directions
//
// Bodies arrive as raw bytes on purpose. The device does no base64, no JSON
// escaping and no protobuf decoding — that all happens here, where CPU is free.

import type { Adb } from "@yume-chan/adb";

import { shell } from "./shell";

/**
 * Only used when nothing is discovered on the device — a build from before the
 * socket name became `netcapture.<pkg>`. Normally the name comes from
 * `listSockets()`, which reads what is actually listening.
 */
export const DEFAULT_SOCKET = "netcapture";

const FRAME_EVENT = 1;
const FRAME_BLOB = 2;
const FRAME_CONTROL = 3;

/** Refuse absurd frames rather than trying to allocate them. */
const MAX_FRAME = 8 * 1024 * 1024;

export type Kind = "http" | "grpc" | "ws";

/** One event as the device emits it. Fields beyond these are kind-specific. */
export interface CaptureEvent {
  v: number;
  kind: Kind;
  phase: string;
  id: string;
  /** Wall clock ms, for display. */
  t: number;
  /** Monotonic ms, for durations that survive a clock change. */
  mono: number;
  thread: string;
  /** Present once the device has started dropping — never silently truncated. */
  dropped?: number;
  [key: string]: unknown;
}

export interface Blob {
  ref: string;
  bytes: Uint8Array;
  /** Original size when the device truncated, else -1. */
  truncatedFrom: number;
}

export interface Hello {
  socket: string;
  pkg: string;
  pid: number;
  uid: number;
  process: string;
  maxTextBody: number;
  maxBinaryBody: number;
}

export interface CaptureSession {
  hello: Hello;
  close(): Promise<void>;
}

export interface CaptureHandlers {
  onBatch(events: CaptureEvent[]): void;
  onBlob(blob: Blob): void;
  onEnd(reason: string): void;
}

/**
 * Open the capture socket. Rejects with a readable message when nothing is
 * listening — which is the common case and means one of three things: the app
 * isn't running, it's a release build, or it's a debug build from before this
 * feature existed.
 */
export async function startCapture(
  adb: Adb,
  socketName: string,
  handlers: CaptureHandlers
): Promise<CaptureSession> {
  let socket;
  try {
    socket = await adb.createSocket(`localabstract:${socketName}`);
  } catch (e) {
    throw new Error(
      `连不上 localabstract:${socketName} —— 目标应用没在运行，` +
        `或者装的是 release 包（release 不含采集代码）。${e instanceof Error ? e.message : ""}`
    );
  }

  const reader = (socket.readable as ReadableStream<Uint8Array>).getReader();
  let closed = false;

  // The first frame is always the device's hello; wait for it so the caller gets
  // a session that is known-good rather than one that fails a second later.
  const frames = readFrames(reader, () => closed);
  const first = await frames.next();
  if (first.done) throw new Error("设备在握手前就关闭了连接");
  const hello = JSON.parse(decode(first.value.payload)) as Hello & { type?: string };
  if (!hello.pkg) throw new Error("握手帧不是预期格式，设备端版本可能过旧");

  // Batch like logcat does: a busy app emits hundreds of events per second and a
  // React update per event would lock the tab up.
  let pending: CaptureEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    handlers.onBatch(batch);
  };

  void (async () => {
    try {
      for (;;) {
        const next = await frames.next();
        if (next.done || closed) break;
        const { type, payload } = next.value;
        if (type === FRAME_EVENT) {
          pending.push(JSON.parse(decode(payload)) as CaptureEvent);
          if (timer === undefined) timer = setTimeout(flush, 100);
        } else if (type === FRAME_BLOB) {
          // Bodies are flushed immediately: they're what the detail pane needs and
          // holding them back behind the event timer only adds latency.
          handlers.onBlob(parseBlob(payload));
        } else if (type === FRAME_CONTROL) {
          // Reserved; the device only sends hello today.
        }
      }
    } catch (e) {
      if (!closed) handlers.onEnd(e instanceof Error ? e.message : String(e));
      return;
    }
    flush();
    if (!closed) handlers.onEnd("设备关闭了采集连接");
  })();

  return {
    hello,
    async close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      // Closing the socket is what tells the device nobody is subscribed, which is
      // what makes the collector go back to zero cost. Do not skip it.
      await Promise.resolve(reader.cancel()).catch(() => {});
      // Tango's close() is declared as MaybePromiseLike, so normalise it.
      await Promise.resolve(socket.close()).catch(() => {});
    },
  };
}

interface RawFrame {
  type: number;
  payload: Uint8Array;
}

/** Reassemble frames from a byte stream that splits wherever it likes. */
async function* readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  isClosed: () => boolean
): AsyncGenerator<RawFrame> {
  let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  for (;;) {
    // Enough for the length prefix?
    while (carry.length >= 4) {
      const len = readU32(carry, 0);
      if (len <= 0 || len > MAX_FRAME) throw new Error(`帧长度不合法：${len}`);
      if (carry.length < 4 + len) break;
      const type = carry[4];
      const payload = carry.subarray(5, 4 + len);
      // Copy: the payload has to outlive the next concat.
      yield { type, payload: new Uint8Array(payload) };
      carry = carry.subarray(4 + len);
    }
    const { done, value } = await reader.read();
    if (done || isClosed()) return;
    carry = concat(carry, value);
  }
}

function parseBlob(payload: Uint8Array): Blob {
  const refLen = (payload[0] << 8) | payload[1];
  const ref = decode(payload.subarray(2, 2 + refLen));
  const truncatedFrom = readI32(payload, 2 + refLen);
  return { ref, bytes: payload.subarray(2 + refLen + 4), truncatedFrom };
}

function concat(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBufferLike> {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function readU32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

function readI32(b: Uint8Array, at: number): number {
  return (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];
}

const decoder = new TextDecoder("utf-8", { fatal: false });
function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * Which collectors are actually listening right now.
 *
 * Names are `netcapture.<packageName>`, so the list doubles as "which apps can I
 * capture" — and the package is readable straight off the name, which is why the
 * SDK stopped competing for a bare `netcapture`: whoever started first won it, and
 * picking it in the UI was a coin flip between apps.
 *
 * Abstract sockets show up in /proc/net/unix with a leading `@`.
 */
export async function listSockets(adb: Adb): Promise<string[]> {
  const out = await shell(adb, "cat /proc/net/unix").catch(() => "");
  const names = new Set<string>();
  for (const line of out.split("\n")) {
    const m = /@(netcapture[\w.]*)/.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

/** `netcapture.com.example.app` → `com.example.app`; unknown shapes come back as-is. */
export function packageOf(socketName: string): string {
  return socketName.startsWith("netcapture.") ? socketName.slice("netcapture.".length) : socketName;
}
