// 把 /api/* 转发到 tunnel 后面的后端。
//
// 存在的理由：页面本体在 Cloudflare Pages 上（静态、边缘分发、陌生人不碰后端那台机器），
// 而 API 只能从内网机器经 cloudflared 出来。一个主机名只能指向一个源，所以要让访客
// 只看见一个域名，就得有人在边缘把 /api/* 接过去。
//
// 本来更合适的工具是 Cloudflare 的 Origin Rules（无代码、无额外延迟），但它的
// Host/SNI/DNS 覆盖是**企业版功能**，Free 版只能改端口。所以用 Pages Function。
//
// ## 身份怎么传下去，以及为什么必须验签
//
// Cloudflare Access 挡在 /api/{auth,remote,dino} 前面（按路径配的）。实测它给
// Pages Function 的是 **JWT**（`cf-access-jwt-assertion`），**不给**
// `cf-access-authenticated-user-email` —— 后者只发给传统 origin。
//
// 而且这两个头的待遇不同（都是实测出来的，不是文档推断）：
//
//   伪造 cf-access-authenticated-user-email → 被 Cloudflare 剥掉，Function 收不到
//   伪造 cf-access-jwt-assertion            → **原样穿透到 Function**
//
// 所以"解码 JWT 取 email"是不够的：任何人对着不受 Access 覆盖的路径发一个自造的 JWT，
// 就能让这里认出一个假身份，而下游后端是凭本 Function 的共享密钥来信任它的 —— 等于
// 直通内网文件和管理接口。因此这里必须用 Access 的公钥验签，并核对 aud / iss / exp。
//
// 验证通过后，邮箱用自有头名 `x-adbstudio-user` 转发（原名会被下一跳剥掉），并附上
// 共享密钥；后端只在密钥匹配时才采信这个头。
//
// ## adb.kakacat.net：kakacat.net 统一登录取代 Access
//
// .net 主机名上没有 Access，身份来自 kakacat.net 签发的 kc_session（ES256，公钥内置在
// _lib/kakacat-sso.js，验签不过就不转发任何身份）。scope 含 adb 才算数：站长和
// deepmirror.com 访客都有，后者进不了别的子站。没有身份时后端对内部功能一律 403，
// 所以这里只需要把「去登录」那一跳（/api/auth/login）接到 kakacat.net。
// .icu 主机名仍然走上面的 Access 验签，不变。

import { ssoSession, ssoChallenge } from "../_lib/kakacat-sso.js";

/** 站长在后端白名单里的邮箱（ADBSTUDIO_ACCESS_EMAILS）。 */
const OWNER_EMAIL = "1046376300mod@gmail.com";

const isNetHost = (host: string) => host === "kakacat.net" || host.endsWith(".kakacat.net");

interface Env {
  /** tunnel 后面的后端主机名，例如 api-adb.kakacat.icu。 */
  API_ORIGIN?: string;
  /** 与后端 ADBSTUDIO_PROXY_SECRET 相同的值。Pages 的加密变量，不进仓库。 */
  PROXY_SECRET?: string;
  /** Access 团队域，例如 example.cloudflareaccess.com。用于取验签公钥。 */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access 应用的 AUD 标签。JWT 的 aud 必须包含它，否则是别的应用签发的。 */
  ACCESS_AUD?: string;
}

const DEFAULT_ORIGIN = "api-adb.kakacat.icu";

/** JWKS 缓存。公钥很少轮换，每个请求去拉一次是纯浪费。 */
let jwks: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

async function accessPublicKeys(teamDomain: string): Promise<JsonWebKey[]> {
  if (jwks && Date.now() - jwks.fetchedAt < JWKS_TTL_MS) return jwks.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  const body = (await res.json()) as { keys: JsonWebKey[] };
  jwks = { keys: body.keys ?? [], fetchedAt: Date.now() };
  return jwks.keys;
}

// 返回类型标注成 Uint8Array<ArrayBuffer>：WebCrypto 的 BufferSource 不接受
// ArrayBufferLike（它可能是 SharedArrayBuffer），而 Uint8Array.from 推出来的正是宽类型。
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bytes = new Uint8Array(new ArrayBuffer(b64.length ? atob(b64).length : 0));
  const raw = atob(b64);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * 验证 Access 签发的 JWT，返回其中的邮箱；任何一步不过就返回 null。
 *
 * 返回 null 时调用方**不得**转发任何身份 —— 那正是伪造 JWT 的攻击路径。
 */
async function verifiedEmail(token: string, env: Env): Promise<string | null> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  if (!teamDomain) return null; // 没配就一律不认：宁可功能不可用，也不能认假身份

  const [headerB64, payloadB64, sigB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) return null;

  let header: { kid?: string; alg?: string };
  let payload: { email?: string; aud?: string | string[]; iss?: string; exp?: number };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch {
    return null;
  }
  // 只接受 Access 实际使用的算法，别给 alg 混淆留门。
  if (header.alg !== "RS256") return null;

  // 先验签，再看声明 —— 顺序反了等于在信任未验证的数据。
  const keys = await accessPublicKeys(teamDomain).catch(() => [] as JsonWebKey[]);
  const candidates = header.kid
    ? keys.filter((k) => (k as { kid?: string }).kid === header.kid)
    : keys;
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = b64urlToBytes(sigB64);
  let ok = false;
  for (const jwk of candidates) {
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
      if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data)) {
        ok = true;
        break;
      }
    } catch {
      /* 这把 key 不适用，试下一把 */
    }
  }
  if (!ok) return null;

  if (payload.exp !== undefined && payload.exp * 1000 <= Date.now()) return null;
  if (payload.iss !== undefined && payload.iss !== `https://${teamDomain}`) return null;
  // aud 必须命中我们这个 Access 应用：同一团队下别的应用签发的 token 不该在这里通行。
  if (env.ACCESS_AUD) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
  }

  return payload.email?.trim().toLowerCase() || null;
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const incoming = new URL(ctx.request.url);
  const target = new URL(
    incoming.pathname + incoming.search,
    `https://${ctx.env.API_ORIGIN ?? DEFAULT_ORIGIN}`
  );

  const headers = new Headers(ctx.request.headers);
  // Host 跟着目标 URL 走（Workers 里手工设 Host 是无效的，路由由 URL 决定），
  // cloudflared 就是按 hostname 匹配 ingress 的。
  headers.set("Host", target.host);

  // 身份：验签通过才转发，且换成自有头名。
  let email: string | null = null;
  if (isNetHost(incoming.hostname)) {
    const session = await ssoSession(ctx.request, "adb");
    if (session) email = session.owner ? OWNER_EMAIL : String(session.sub).toLowerCase();
    // 未登录点「登录」：去 kakacat.net，回来时再走一遍这里，后端按 redirect_url 送回原页面。
    // 主站的访问态只有 30 分钟，所以先试静默续签，续过一轮还不行才会落到登录页。
    if (!session && incoming.pathname === "/api/auth/login") {
      return Response.redirect(ssoChallenge(incoming.toString()), 302);
    }
  } else {
    const jwt = ctx.request.headers.get("cf-access-jwt-assertion");
    email = jwt ? await verifiedEmail(jwt, ctx.env) : null;
  }
  // 登录态只在边缘这里用，别把它带进内网后端
  const cookie = headers.get("Cookie");
  if (cookie) {
    const rest = cookie.split(";").filter((p) => p.trim().split("=")[0] !== "kc_session").join(";");
    if (rest.trim()) headers.set("Cookie", rest);
    else headers.delete("Cookie");
  }
  if (email) headers.set("x-adbstudio-user", email);
  else headers.delete("x-adbstudio-user"); // 别让调用方自己塞一个进来

  if (ctx.env.PROXY_SECRET) headers.set("x-adbstudio-proxy", ctx.env.PROXY_SECRET);
  // 这两个头由 Cloudflare 在**下一跳**重新计算；照抄过去会自相矛盾。
  headers.delete("cf-connecting-ip");
  headers.delete("x-forwarded-for");

  // WebSocket（/api/adb 是 adb 中继）不能当普通 fetch 处理：要把 101 和那对 socket
  // 原样传回去，否则升级会在这里被吃掉。
  if (ctx.request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    const upstream = await fetch(target.toString(), {
      method: ctx.request.method,
      headers,
      body: ctx.request.body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
      webSocket: (upstream as unknown as { webSocket?: WebSocket }).webSocket,
    } as ResponseInit & { webSocket?: WebSocket });
  }

  const upstream = await fetch(target.toString(), {
    method: ctx.request.method,
    headers,
    body:
      ctx.request.method === "GET" || ctx.request.method === "HEAD"
        ? undefined
        : ctx.request.body,
    redirect: "manual",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
};
