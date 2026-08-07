// 诊断日志：本机记录，出问题时一键上传。
//
// Why this exists: the failures worth debugging here are the ones that only
// happen on someone else's machine. "USB 被 adb 占着" depends on what else is
// running; a WebUSB claim can fail for a driver reason that never reproduces on
// the developer's laptop. Screenshots of a toast don't carry any of that.
//
// So the page keeps a ring buffer of what it tried and what came back, and offers
// to upload it. Explicitly — nothing leaves the machine without a click. What
// goes up is listed in `snapshot()`: no file contents, no device screen, no page
// URLs beyond this app's own origin.
//
// The upload lives at `/diag`, deliberately NOT under `/api/*`: on the hosted
// deployment `/api/*` is forwarded to a backend behind a tunnel (see
// functions/api/[[path]].ts), and a diagnostic report has no business going
// there — it belongs to the Pages Function next to it.

const MAX_EVENTS = 400;
/** Cap on what we keep and send; a report is meant to be read, not archived. */
const MAX_BYTES = 96 * 1024;
const STORE_KEY = "adbstudio.diag";

export interface DiagEvent {
  /** Wall clock, ms. */
  t: number;
  kind: string;
  msg: string;
  data?: unknown;
}

let events: DiagEvent[] = [];
/** The tail of the previous page load, so a report survives a reload. */
let previous: DiagEvent[] = [];
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function persist(): void {
  if (persistTimer !== undefined) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(events.slice(-120)));
    } catch {
      // Storage full or blocked — logging must never be the thing that breaks.
    }
  }, 1000);
}

/** Strip anything that can't be structured-cloned or would be huge. */
function safe(data: unknown): unknown {
  if (data === undefined) return undefined;
  if (data instanceof Error) return { name: data.name, message: data.message };
  try {
    const text = JSON.stringify(data);
    if (text === undefined) return String(data);
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : JSON.parse(text);
  } catch {
    return String(data);
  }
}

export function log(kind: string, msg: string, data?: unknown): void {
  events.push({ t: Date.now(), kind, msg, ...(data === undefined ? {} : { data: safe(data) }) });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  persist();
}

/**
 * Which build this is.
 *
 * Taken from the bundle's own hashed filename rather than a build-time constant:
 * it needs no vite config, and it maps one-to-one onto a deployment — given a
 * report you can tell exactly which upload it came from.
 */
export function bundleVersion(): string {
  const main = [...document.scripts]
    .map((s) => s.src.split("/").pop() ?? "")
    .find((n) => /^index-.*\.js$/.test(n));
  return main ?? "dev";
}

/** Wire up the passive collectors. Called once from main.tsx. */
export function initDiag(version: string): void {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) previous = JSON.parse(raw) as DiagEvent[];
  } catch {
    previous = [];
  }
  log("boot", "page loaded", { version, url: location.pathname });

  // An exception nobody sees is exactly what a user reports as "什么都没发生".
  window.addEventListener("error", (e) => {
    log("error", e.message, { file: e.filename, line: e.lineno, col: e.colno });
  });
  window.addEventListener("unhandledrejection", (e) => {
    log("rejection", String((e.reason as Error)?.message ?? e.reason));
  });
}

export interface DiagReport {
  version: string;
  note: string;
  env: Record<string, unknown>;
  usb: unknown[];
  state: Record<string, unknown>;
  previous: DiagEvent[];
  events: DiagEvent[];
}

/**
 * What gets uploaded.
 *
 * Device serials are included: they are the join key between a report and a
 * phone on someone's desk, and they identify hardware the reporter owns rather
 * than a person. Everything else is capability and outcome — no file bytes, no
 * screen contents, no credentials (the API token is never read here).
 */
export async function snapshot(
  version: string,
  note: string,
  state: Record<string, unknown>,
): Promise<DiagReport> {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string; brands?: unknown };
    usb?: { getDevices(): Promise<unknown[]> };
  };

  let usb: unknown[] = [];
  try {
    const list = (await nav.usb?.getDevices()) ?? [];
    usb = list.map((d) => {
      const dev = d as {
        vendorId: number;
        productId: number;
        serialNumber?: string;
        productName?: string;
        manufacturerName?: string;
        opened: boolean;
        configuration?: { configurationValue: number } | null;
      };
      return {
        vendorId: dev.vendorId,
        productId: dev.productId,
        serial: dev.serialNumber,
        product: dev.productName,
        vendor: dev.manufacturerName,
        // The two facts that decide whether a claim can succeed.
        opened: dev.opened,
        configured: dev.configuration != null,
      };
    });
  } catch (e) {
    usb = [{ error: String((e as Error).message ?? e) }];
  }

  return {
    version,
    note,
    env: {
      ua: navigator.userAgent,
      platform: nav.userAgentData?.platform ?? "unknown",
      language: navigator.language,
      secureContext: window.isSecureContext,
      webusb: typeof navigator.usb !== "undefined",
      webcodecs: typeof VideoEncoder !== "undefined",
      origin: location.origin,
      screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      at: new Date().toISOString(),
    },
    usb,
    state,
    previous,
    events,
  };
}

export interface UploadResult {
  id: string;
}

/** Send a report. Throws with a readable message; the caller shows it. */
export async function upload(report: DiagReport): Promise<UploadResult> {
  let body = JSON.stringify(report);
  if (body.length > MAX_BYTES) {
    // Drop the oldest events rather than the environment, which is the part that
    // explains the machine.
    const trimmed = { ...report, previous: [], events: report.events.slice(-150) };
    body = JSON.stringify(trimmed);
  }
  const res = await fetch("/diag", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`上传失败：HTTP ${res.status}${text ? ` ${text.slice(0, 120)}` : ""}`);
  }
  return (await res.json()) as UploadResult;
}
