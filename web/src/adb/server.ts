// The *other* transport: talking to a real adb server through the backend's
// WebSocket↔TCP relay.
//
// WebUSB (session.ts) covers devices plugged into the user's machine. It cannot
// cover wireless devices, because a browser has no raw TCP and Android 11+
// requires TLS on the debugging port. So for those we drive a genuine adb server
// running next to the backend: Tango's `AdbServerClient` speaks the adb *server*
// protocol over any byte duplex, and a relayed WebSocket is exactly that.
//
// Both paths produce a plain `Adb`, so everything above this layer — apps,
// files, mirroring, screenshots — is written once and works with either.

import { AdbServerClient } from "@yume-chan/adb";
import type { Adb, AdbIncomingSocketHandler } from "@yume-chan/adb";
// Use Tango's stream types, not the DOM lib's: they differ in whether
// `closed`/`close()` resolve to `undefined` or `void`, and the interface we
// implement is declared with Tango's.
import { MaybeConsumable, ReadableStream } from "@yume-chan/stream-extra";
import type {
  MaybeConsumable as MaybeConsumableType,
  ReadableStream as ReadableStreamType,
  WritableStream as WritableStreamType,
} from "@yume-chan/stream-extra";

import { apiBase, withToken } from "../api";
import type { Device } from "../types";

/**
 * Where the relay lives. Two deployments, same binary:
 *
 *   * same-origin (default) — the backend next to the app, whose adb server sees
 *     devices on the *server's* network. This is what gives us wireless devices.
 *
 *   * a bridge on the user's own machine (`ws://127.0.0.1:7070/api/adb`) — then
 *     the adb server is the local one that already owns the USB interface, so
 *     devices work without `adb kill-server` and coexist with Android Studio.
 *     Stored in localStorage; see settings in the UI.
 *
 * `ws://127.0.0.1` from an https:// page is not blocked as mixed content —
 * loopback counts as potentially trustworthy — but it *is* subject to Chrome's
 * Local Network Access check, which is a separate gate. A real browser asks the
 * user once and remembers "allow"; headless Chrome denies it with no prompt and
 * reports `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`. Both behaviours measured,
 * see `scripts/verify-local-bridge.mjs`. That is why this connection can only be
 * verified in a real browser window.
 */
const BRIDGE_KEY = "adbstudio.bridgeUrl";

export function bridgeOverride(): string | null {
  return localStorage.getItem(BRIDGE_KEY);
}

export function setBridgeOverride(url: string | null): void {
  if (url) localStorage.setItem(BRIDGE_KEY, url);
  else localStorage.removeItem(BRIDGE_KEY);
}

/** The default local bridge address, matching the server's default port. */
export const LOCAL_BRIDGE_URL = "ws://127.0.0.1:7070/api/adb";

export interface BridgeBuild {
  file: string;
  label: string;
  /** What has to happen before a freshly downloaded file will run. */
  note?: string;
}

/**
 * The prebuilt bridge for the machine the page is open on.
 *
 * Guessed from the user agent, which is unreliable in general but fine here: the
 * worst case is offering the wrong file, and all three are listed anyway. Only
 * the platforms that are actually built get an entry — see
 * `.github/workflows/bridge.yml`.
 */
export const BRIDGE_BUILDS: BridgeBuild[] = [
  {
    file: "adbstudio-bridge-macos-arm64",
    label: "macOS（Apple 芯片）",
    note: "下载后先 chmod +x，首次打开右键点“打开”绕过未签名拦截",
  },
  { file: "adbstudio-bridge-windows-x64.exe", label: "Windows 10+", note: "双击运行即可" },
  {
    file: "adbstudio-bridge-linux-x64",
    label: "Linux x64（Ubuntu 18.04+）",
    note: "下载后 chmod +x 再运行",
  },
];

export function guessBridgeBuild(): BridgeBuild | undefined {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return BRIDGE_BUILDS[1];
  if (/Mac OS X|Macintosh/i.test(ua)) return BRIDGE_BUILDS[0];
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return BRIDGE_BUILDS[2];
  return undefined;
}

export function bridgeDownloadUrl(file: string): string {
  return `${apiBase()}/download/${file}`;
}

function relayUrl(): string {
  const override = bridgeOverride();
  let url: string;
  if (override) {
    url = override;
  } else {
    // Follow the configured API base when the page is hosted separately from the
    // backend; otherwise same-origin.
    const base = apiBase();
    if (base) {
      const parsed = new URL(`${base}/api/adb`);
      parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
      url = parsed.toString();
    } else {
      const parsed = new URL("/api/adb", window.location.href);
      parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
      url = parsed.toString();
    }
  }
  // The WebSocket API can't set an Authorization header, so the token goes in the
  // query string. Always attach it when we have one: whether a token is required
  // is the server's configuration, not something the address tells us — a local
  // bridge can be token-protected too. A server with auth disabled ignores it.
  return withToken(url);
}

/**
 * One WebSocket to the relay, presented as the byte duplex `AdbServerClient`
 * wants. The adb server protocol uses a fresh connection per request, so a new
 * one of these is created for every command — cheap, since it's same-origin.
 */
class RelayConnection implements AdbServerClient.ServerConnection {
  readonly readable: ReadableStreamType<Uint8Array>;
  readonly writable: WritableStreamType<MaybeConsumableType<Uint8Array>>;
  readonly closed: Promise<undefined>;

  #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;

    let closeResolve: () => void;
    this.closed = new Promise<undefined>((resolve) => {
      closeResolve = () => resolve(undefined);
    });

    this.readable = new ReadableStream<Uint8Array>({
      start(controller) {
        socket.onmessage = (e) => {
          controller.enqueue(new Uint8Array(e.data as ArrayBuffer));
        };
        socket.onclose = () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          closeResolve();
        };
        socket.onerror = () => {
          controller.error(new Error("与后端的 adb 中继连接失败"));
          closeResolve();
        };
      },
      cancel() {
        socket.close();
      },
    });

    // MaybeConsumable.WritableStream unwraps Consumable chunks and marks them
    // consumed once `write` resolves, which is what applies backpressure.
    this.writable = new MaybeConsumable.WritableStream<Uint8Array>({
      write(chunk) {
        // Copy: `send` is asynchronous and Tango reuses its chunk buffers once
        // `write` resolves, so handing the live view over can corrupt frames.
        socket.send(new Uint8Array(chunk).buffer as ArrayBuffer);
      },
    });
  }

  /** Opens the socket and resolves once it's ready to carry bytes. */
  static async open(): Promise<RelayConnection> {
    const socket = new WebSocket(relayUrl());
    socket.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () =>
        reject(
          new Error(
            "无法连接后端 adb 中继（/api/adb）。确认服务端已启动，且服务端的 adb server 在运行。"
          )
        );
    });
    return new RelayConnection(socket);
  }

  close(): void {
    this.#socket.close();
  }
}

const connector: AdbServerClient.ServerConnector = {
  connect: () => RelayConnection.open(),
  // Reverse tunnels would need the *browser* to accept inbound connections, which
  // it cannot. Callers must therefore ask for a forward tunnel explicitly —
  // Tango does NOT fall back on its own (see `tunnelForward` in adb/scrcpy.ts,
  // where getting this wrong made mirroring fail outright).
  addReverseTunnel: (_handler: AdbIncomingSocketHandler, _address?: string) => {
    throw new Error("反向隧道在网页版不支持（请改用 forward tunnel）");
  },
  removeReverseTunnel: () => {},
  clearReverseTunnels: () => {},
};

export const serverClient = new AdbServerClient(connector);

/** Is the backend relay reachable and is an adb server behind it? */
export async function serverAvailable(): Promise<boolean> {
  try {
    await serverClient.getVersion();
    return true;
  } catch {
    return false;
  }
}

function toDevice(d: AdbServerClient.Device): Device {
  return {
    id: `bridge:${d.serial}`,
    serial: d.serial,
    name: d.model ?? d.product ?? d.serial,
    state: d.state,
    // adb uses a `host:port` serial for TCP transports; anything else is USB.
    connection: /:\d+$/.test(d.serial) ? "wifi" : "usb",
    source: "bridge",
    model: d.model,
    product: d.product,
  };
}

/** Devices the backend's adb server knows about. */
export async function listServerDevices(): Promise<Device[]> {
  const devices = await serverClient.getDevices();
  return devices.map(toDevice);
}

/** Open an `Adb` for a device the adb server owns. */
export function connectServerDevice(serial: string): Promise<Adb> {
  return serverClient.createAdb({ serial });
}

/**
 * Wait for a device to be back in the `device` state.
 *
 * Needed after anything that restarts adbd. The adb server identifies a
 * connection by transport id, and a restarted daemon comes back under a *new*
 * one — every call on the old object then fails with "no device with transport
 * id 'N'". So the wait is not a politeness, it is how a fresh transport gets
 * acquired.
 */
export async function waitForDevice(serial: string, timeoutMs = 30000): Promise<void> {
  await Promise.race([
    serverClient.waitFor({ serial }, "device"),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("等待设备重新上线超时")), timeoutMs)
    ),
  ]);
}

/**
 * Watch the adb server's device list.
 *
 * `host:track-devices` pushes a new list whenever anything is plugged, unplugged
 * or changes state, which is what makes hot-swapping a device work without the
 * user reaching for a refresh button. Returns a stop function; the caller must
 * call it, because the observer holds a WebSocket open for as long as it lives.
 */
export async function trackDevices(
  onChange: (devices: Device[]) => void
): Promise<() => void> {
  const observer = await serverClient.trackDevices();
  const emit = () => onChange(observer.current.map(toDevice));
  const off = observer.onListChange(emit);
  emit();
  return () => {
    off();
    void observer.stop();
  };
}
