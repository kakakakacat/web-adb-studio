// Client for the backend's REST endpoints — the features a browser can't do
// itself. Everything ADB-related goes through src/adb/ instead and never touches
// this file.


// --- where the backend is, and how we authenticate to it -----------------
//
// Same-origin by default (the server hosts the bundle). An override lets a
// statically-hosted page — Cloudflare Pages, say — point at a backend reached
// through a tunnel. The token is the server's ADBSTUDIO_TOKEN; it is required
// whenever the backend isn't loopback-only.

const BASE_KEY = "adbstudio.apiBase";
const TOKEN_KEY = "adbstudio.token";

/**
 * 构建期注入的 API 地址（`VITE_API_BASE`）。
 *
 * 前端放 Cloudflare Pages、API 经 tunnel 出的拆分部署下，两者不同源，Pages 上的
 * 静态包必须知道 API 在哪；而同源部署（服务端自己托管这个包）留空即可。
 * localStorage 的手工覆盖优先级最高，用于把同一个页面指向另一个后端。
 */
const BUILD_TIME_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");

export function apiBase(): string {
  const override = localStorage.getItem(BASE_KEY);
  // 自愈：拆分部署（有构建期 API 地址）下，一个指向**页面自己 origin** 的覆盖项只可能
  // 是同源时代留下的残留 —— 现在页面在 Pages 上，那个 origin 下根本没有 /api，结果是
  // 后端永远不可达，而且这个状态会跨刷新一直存在。这种残留没有任何有效用途，直接丢掉。
  if (
    override &&
    BUILD_TIME_BASE &&
    override.replace(/\/+$/, "") === window.location.origin
  ) {
    localStorage.removeItem(BASE_KEY);
    return BUILD_TIME_BASE;
  }
  return override ?? BUILD_TIME_BASE;
}

/** 是否是「前端在 Pages、API 在另一个 hostname」那种拆分部署。 */
export function isSplitDeployment(): boolean {
  return BUILD_TIME_BASE !== "";
}

/**
 * 跨源时必须显式带凭据，否则浏览器不会发送 Cloudflare Access 的 CF_Authorization
 * cookie（默认的 same-origin 策略把它挡掉），内网功能就永远是"未登录"。
 *
 * 同源部署下这个值无害：same-origin 请求本来就带 cookie。
 */
export const CREDENTIALS: RequestCredentials = "include";

export function setApiBase(base: string | null): void {
  if (base) localStorage.setItem(BASE_KEY, base.replace(/\/+$/, ""));
  else localStorage.removeItem(BASE_KEY);
}

declare global {
  interface Window {
    /** Injected by the backend when it serves index.html (see server/src/main.rs). */
    __ADBSTUDIO_TOKEN__?: string;
  }
}

/**
 * The token to authenticate with.
 *
 * A backend that serves this page injects its own, so a same-origin deployment
 * needs no per-machine setup. An explicitly saved one wins, because that's how you
 * point this page at a *different* backend than the one that served it.
 */
export function apiToken(): string | null {
  return localStorage.getItem(TOKEN_KEY) ?? window.__ADBSTUDIO_TOKEN__ ?? null;
}

export function setApiToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/**
 * Accept `#token=…` (and optionally `&api=…`) once, then scrub it from the URL
 * so the secret doesn't sit in the address bar or get copy-pasted into chat.
 */
export function adoptCredentialsFromUrl(): boolean {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  const token = params.get("token");
  const base = params.get("api");
  if (!token && !base) return false;
  if (token) setApiToken(token);
  if (base) setApiBase(base);
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return true;
}

/** Append the token as a query param, for URLs the browser fetches itself. */
export function withToken(url: string): string {
  const token = apiToken();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/**
 * 带鉴权和错误提取的 JSON 请求入口。
 *
 * 本仓库里暂时没有调用方 —— 需要身份的接口在私有的下游仓库里。
 * 保留它是因为它正是给「自己加一个后端接口」用的现成入口：token/身份头、
 * 非 2xx 时把服务端返回的 {"error": "..."} 提取成异常消息，都已经处理好了。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body) headers["Content-Type"] = "application/json";
  const token = apiToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  // 所有内网功能都经过这里，跨源时少了 credentials 就等于永远未登录。
  const res = await fetch(`${apiBase()}/api${path}`, {
    ...init,
    headers,
    credentials: CREDENTIALS,
  });
  if (!res.ok) {
    // Handlers return {"error": "..."} — surface that text, not "500".
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

// --- health --------------------------------------------------------------

export interface Health {
  ok: boolean;
  version: string;
  features: {
    remoteFiles: boolean;
    dino: boolean;
    /** An adb server is actually reachable behind the relay (probed, not assumed). */
    adbServer: boolean;
    /** This deployment expects a signed-in identity; absent means no sign-in exists. */
    accessIdentity: boolean;
  };
  /**
   * May this caller use the identity-gated features? Company addresses and the
   * allow-list only; everyone else still gets the full ADB feature set.
   */
  privileged: boolean;
  adbServer: string;
  /** Address Cloudflare Access verified, when it's in front. Null on the local
   *  loopback path, where there is no Access hop. */
  user?: string | null;
}

/**
 * Why the backend is or isn't usable.
 *
 * "wrong token" and "not running" have to be distinguished: they look identical
 * from a failed request but need completely different fixes, and reporting a bad
 * token as "not running" sends people off to restart a service that is fine.
 */
export type BackendStatus =
  | { kind: "ok"; health: Health }
  | { kind: "unauthorized" }
  | { kind: "unreachable"; detail: string };

export async function backendStatus(): Promise<BackendStatus> {
  try {
    const token = apiToken();
    const res = await fetch(`${apiBase()}/api/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      credentials: CREDENTIALS,
    });
    if (res.status === 401) return { kind: "unauthorized" };
    if (!res.ok) return { kind: "unreachable", detail: `HTTP ${res.status}` };
    return { kind: "ok", health: (await res.json()) as Health };
  } catch (e) {
    // Network-level failure: not running, wrong address, TLS rejected, or blocked
    // by the browser (e.g. a public page calling a private address).
    return { kind: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** null when the backend isn't usable — the app stays usable for USB-only work. */
export async function health(): Promise<Health | null> {
  const status = await backendStatus();
  return status.kind === "ok" ? status.health : null;
}

// 需要内网才能用的接口不在这个仓库里 —— 它们依赖各自的私有环境，
// 放在私有仓库中作为本仓库的下游。这里只保留身份认证本身：一个自托管者可以用同一套
// Cloudflare Access 机制去给自己新增的接口把门。

// --- signing in ------------------------------------------------------------

/**
 * Send the browser through Cloudflare Access to get an identity.
 *
 * There is no API for this: Access authenticates a *navigation*, sets its cookie
 * for the hostname, and redirects back. A fetch() can't do that — it would be
 * met with a 302 to the login page that the page cannot follow meaningfully — so
 * the only way is to actually leave and come back.
 *
 * The target is an internal endpoint rather than the site root, because on this
 * deployment only the internal paths are covered by an Access policy. Landing on
 * a covered path is what triggers the login; once the cookie is set, every later
 * request to those paths carries it and the backend sees the verified address.
 */
/** The Access-covered path used both to log in and to ask who we are. */
const AUTH_PATH = "/api/auth";

const SIGNIN_TRIED_KEY = "adbstudio.signInTried";

export interface Identity {
  user: string;
  privileged: boolean;
}

/**
 * Who Cloudflare Access says we are, or null if nobody.
 *
 * This can't come from `/api/health`: that path is public now, and Cloudflare
 * only injects the identity header on requests it authenticates, so health
 * reports `user: null` even to someone perfectly well signed in. `/api/auth` is
 * inside the Access application, so reaching it at all proves an identity —
 * which is exactly why the *failure* here is the informative case: an anonymous
 * visitor is redirected to the login portal, the cross-origin hop has no CORS
 * headers, and the fetch rejects. That's "not signed in", not an error.
 */
export async function identity(): Promise<Identity | null> {
  try {
    const res = await fetch(`${apiBase()}${AUTH_PATH}/whoami`, {
      credentials: CREDENTIALS,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: string | null; privileged?: boolean };
    return body.user ? { user: body.user, privileged: body.privileged ?? false } : null;
  } catch {
    return null;
  }
}

/** Forget that an attempt was made — called once an identity actually exists. */
export function signInSucceeded(): void {
  sessionStorage.removeItem(SIGNIN_TRIED_KEY);
}

/**
 * Where Cloudflare Access sends people to log in, asked of Access itself.
 *
 * The team domain is deployment-specific, so it isn't hardcoded: Access answers
 * for it on a public, same-origin `.well-known` path describing any protected
 * resource. Null if the lookup fails or the path isn't protected at all.
 */
async function accessTeamDomain(): Promise<string | null> {
  try {
    // Bounded: this sits between the click and the navigation, and a sign-out that
    // hangs on a metadata lookup is worse than one that skips the logout hop.
    const res = await fetch(
      `${apiBase()}/.well-known/cloudflare-access-protected-resource${AUTH_PATH}/whoami`,
      { signal: AbortSignal.timeout(4000), credentials: CREDENTIALS }
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { protected?: boolean; team_domain?: string };
    return body.protected && body.team_domain ? body.team_domain : null;
  } catch {
    return null;
  }
}

/** Absolute URL of the login landing spot, coming back to `returnTo` after. */
function loginUrl(returnTo: string): string {
  const path = returnTo.startsWith("/") ? returnTo : "/";
  // 同源部署给相对路径就够了。
  //
  // 拆分部署（前端在 Pages、API 在另一个 hostname）下，登录发生在 API 那个 origin
  // 上，跳回来必须是绝对地址 —— 服务端只接受 ADBSTUDIO_ALLOWED_ORIGINS 里列过的
  // origin，所以这不是开放重定向。
  const target = apiBase()
    ? new URL(path, window.location.origin).href
    : path;
  return new URL(
    `${apiBase()}${AUTH_PATH}/login?redirect_url=${encodeURIComponent(target)}`,
    window.location.href
  ).href;
}

/**
 * Send the browser through Cloudflare Access to get an identity.
 *
 * There is no API for this: Access authenticates a *navigation*, sets its cookie
 * for the hostname, and redirects back. A fetch() can't do that — it would be
 * met with a 302 to the login page that the page cannot follow meaningfully — so
 * the only way is to actually leave and come back.
 */
export function signIn(returnTo: string = window.location.pathname): void {
  const target = loginUrl(returnTo);

  // First attempt goes straight at the protected path: if an IdP session already
  // exists, Access signs the visitor in without asking anything.
  if (sessionStorage.getItem(SIGNIN_TRIED_KEY) === null) {
    sessionStorage.setItem(SIGNIN_TRIED_KEY, "1");
    window.location.href = target;
    return;
  }

  // We've been here before and still have no identity, so the last attempt
  // failed — most often a Google account the Access policy refuses. Going back
  // to the protected path would just replay that same identity and land on the
  // same denial *immediately*, with no way to choose differently. Dropping the
  // Access session first is what turns the second click into a real retry:
  // the account picker comes back.
  void accessTeamDomain().then((team) => {
    window.location.href = team
      ? `https://${team}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(target)}`
      : target;
  });
}

/**
 * Drop the Cloudflare Access session and come back signed out.
 *
 * Team-level logout, not the per-application one: clearing only this app's cookie
 * leaves the IdP session standing, so the next sign-in silently returns the same
 * identity — useless to someone who wants to switch accounts, which is most of
 * why anyone signs out of this page.
 */
export async function signOut(returnTo: string = window.location.pathname): Promise<void> {
  signInSucceeded();
  const home = new URL(returnTo.startsWith("/") ? returnTo : "/", window.location.href).href;
  const team = await accessTeamDomain();
  // Falling back to just going home would leave the session standing and the page
  // signed in again after the reload — the one outcome a sign-out must not have.
  // The per-application logout at least clears this hostname's cookie.
  window.location.href = team
    ? `https://${team}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(home)}`
    : `${apiBase()}/cdn-cgi/access/logout`;
}
