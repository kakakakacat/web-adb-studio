/**
 * kakacat.net 统一登录 —— 子站验签（Workers / Pages Functions / Node 18+ 通用，只用 WebCrypto）。
 *
 * 复制本文件到子站即可，不需要任何密钥：登录态由 kakacat.net 用 ES256 私钥签发，这里只用公钥验。
 *
 *   import { ssoSession, ssoChallenge } from './kakacat-sso.js';
 *   const s = await ssoSession(request, 'adb');   // 本站的权限键（子域名第一段）
 *   if (!s) return Response.redirect(ssoChallenge(request.url), 302);   // 页面
 *   if (!s) return new Response('未登录', { status: 401 });             // 接口
 *   s.sub   → 'owner'（站长）或访客邮箱
 *   s.owner → 是否站长
 *
 * 权限：登录态的 scope 含 '*'（站长）或本站的键才算通过；访客只拿得到自己被授权的站。
 *
 * 登录态只有 30 分钟 —— 子站是离线验签、看不见主站的吊销，短命是唯一的兜底。
 * 过期后 ssoChallenge() 把人送去 /auth/refresh，主站拿 host-only 的续签凭证（子站永远拿不到它）
 * 现查一遍权限、补一枚新的访问态，再原样送回来。用户什么都不用做。
 *
 * 公钥按 kid 从 /.well-known/jwks.json 取，拉不到就用下面内置的这把 ——
 * 所以轮换密钥只要在主站换，子站不用一个个改代码重新部署。
 * 本地测试要自己签登录态时，把自己的公钥当第三个参数传进来，就完全不碰网络。
 */

export const PUBLIC_JWK = {"kty": "EC", "crv": "P-256", "x": "1zAEFzEd9Iu8IXjJ36YC3gAKMBOCCSZpnV_i1C867Vw", "y": "T6EMAQhuy477hfd0CVgIWjwLajnUtY8uTg5wWljvBgY", "kid": "20261014", "alg": "ES256", "use": "sig"};

const ZONE = 'kakacat.net';
const ISS = `https://${ZONE}`;
const JWKS_URL = `${ISS}/.well-known/jwks.json`;
export const SSO_COOKIE = 'kc_session';

/** 续签回跳时带的标记：带着它来还是没登录态，就别再续了，直接去登录页（防死循环） */
const TRIED = '_kc';
const JWKS_COOLDOWN = 60_000;

const importJwk = (jwk) =>
  crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);

const keys = new Map(); // kid -> Promise<CryptoKey>
let lastFetch = 0;

/** 没见过的 kid 才去拉 JWKS，拉完缓存在 isolate 里；失败就沉默，让验签自然失败。 */
async function loadJwks() {
  if (Date.now() - lastFetch < JWKS_COOLDOWN) return;
  lastFetch = Date.now();
  try {
    const r = await fetch(JWKS_URL, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return;
    for (const k of (await r.json()).keys || []) {
      if (k.kid && k.kty === 'EC' && k.crv === 'P-256') keys.set(k.kid, importJwk(k));
    }
  } catch {}
}

async function keyFor(kid, override) {
  if (override) {
    const id = `${override.x}.${override.y}`;
    if (!keys.has(id)) keys.set(id, importJwk(override));
    return keys.get(id);
  }
  const want = kid || PUBLIC_JWK.kid;
  if (!keys.has(PUBLIC_JWK.kid)) keys.set(PUBLIC_JWK.kid, importJwk(PUBLIC_JWK));
  if (!keys.has(want)) await loadJwks();
  return keys.get(want) || null;
}

const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** 校验一枚登录态 token，并要求 scope 覆盖 site；通过返回 payload（附 owner 字段），否则 null。 */
export async function ssoVerify(token, site, jwk) {
  try {
    const [head, body, sig] = String(token).split('.');
    const kid = JSON.parse(new TextDecoder().decode(unb64u(head))).kid;
    const key = await keyFor(kid, jwk);
    if (!key) return null;
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await key,
      unb64u(sig),
      new TextEncoder().encode(`${head}.${body}`),
    );
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (p.iss !== ISS || p.aud !== ZONE || !p.sub || !Array.isArray(p.scope) || !(p.exp > Date.now() / 1000)) return null;
    const owner = p.scope.includes('*');
    if (!owner && !(site && p.scope.includes(site))) return null;
    // role 是本站内部的角色（user / readonly / admin），由主站 grants 决定；
    // kind 区分真人账号和访问码；旧登录态没有这两个字段，按最宽松的默认值走。
    return { ...p, owner, kind: p.kind || (owner ? 'owner' : 'user'), role: owner ? 'admin' : p.roles?.[site] || 'user', who: p.name || p.sub };
  } catch {
    return null;
  }
}

/** 从 Request（或 Cookie 头字符串）里取登录态并校验。site 省略 = 只认站长。 */
export async function ssoSession(requestOrCookieHeader, site, jwk) {
  const raw =
    typeof requestOrCookieHeader === 'string'
      ? requestOrCookieHeader
      : requestOrCookieHeader?.headers?.get?.('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SSO_COOKIE) return ssoVerify(part.slice(i + 1).trim(), site, jwk);
  }
  return null;
}

/** 去主站登录、登录完回到 returnTo 的地址。 */
export const ssoLoginUrl = (returnTo) => `${ISS}/login?next=${encodeURIComponent(returnTo)}`;

/**
 * 页面没拿到登录态时该把人送去哪儿：先试静默续签，续过一轮还不行就去登录页。
 * 只用于 GET 页面；接口直接回 401，让前端自己决定要不要跳。
 */
export function ssoChallenge(url) {
  const u = new URL(url);
  if (u.searchParams.has(TRIED)) {
    u.searchParams.delete(TRIED);
    return ssoLoginUrl(u.toString());
  }
  return `${ISS}/auth/refresh?next=${encodeURIComponent(u.toString())}`;
}

/** 续签成功后把 URL 上的 _kc 痕迹擦掉；不需要跳转就返回 null。 */
export function ssoCleanUrl(url) {
  const u = new URL(url);
  if (!u.searchParams.has(TRIED)) return null;
  u.searchParams.delete(TRIED);
  return u.toString();
}

/**
 * 访问日志上报：一个会话第一次进本站时调一次，主站记一条 enter。
 * 失败完全忽略 —— 日志不能影响放行。调用方自己去重（同一个 s.jti 只报一次）：
 *
 *   if (s && !reported.has(s.jti)) { reported.add(s.jti); ctx.waitUntil(ssoReport(request, s)); }
 */
export async function ssoReport(request, session, detail) {
  try {
    await fetch(`${ISS}/api/access/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: new URL(request.url).origin, Cookie: request.headers.get('Cookie') || '' },
      body: JSON.stringify({ event: session ? 'enter' : 'deny', detail }),
    });
  } catch {}
}
