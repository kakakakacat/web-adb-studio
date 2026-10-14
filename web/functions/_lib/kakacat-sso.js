/**
 * kakacat.net 统一登录 —— 子站验签（Workers / Pages Functions / Node 18+ 通用，只用 WebCrypto）。
 *
 * 复制本文件到子站即可，不需要任何密钥：登录态由 kakacat.net 用 ES256 私钥签发，这里只用公钥验。
 *
 *   import { ssoSession, ssoLoginUrl } from './kakacat-sso.js';
 *   const s = await ssoSession(request, 'adb');   // 本站的权限键（子域名第一段）
 *   if (!s) return Response.redirect(ssoLoginUrl(request.url), 302);
 *   s.sub   → 'owner'（站长）或访客邮箱
 *   s.owner → 是否站长
 *
 * 权限：登录态的 scope 含 '*'（站长）或本站的键才算通过；访客只拿得到自己被授权的站。
 *
 * 公钥换了（kakacat-home 重新跑 gen-key）要同步改下面的 PUBLIC_JWK。
 */

export const PUBLIC_JWK = {"kty": "EC", "crv": "P-256", "x": "1zAEFzEd9Iu8IXjJ36YC3gAKMBOCCSZpnV_i1C867Vw", "y": "T6EMAQhuy477hfd0CVgIWjwLajnUtY8uTg5wWljvBgY", "kid": "20261014", "alg": "ES256", "use": "sig"};

const ZONE = 'kakacat.net';
const ISS = `https://${ZONE}`;
export const SSO_COOKIE = 'kc_session';

let keyPromise;
const pubKey = () =>
  (keyPromise ||= crypto.subtle.importKey(
    'jwk',
    { kty: PUBLIC_JWK.kty, crv: PUBLIC_JWK.crv, x: PUBLIC_JWK.x, y: PUBLIC_JWK.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  ));

const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** 校验一枚登录态 token，并要求 scope 覆盖 site；通过返回 payload（附 owner 字段），否则 null。 */
export async function ssoVerify(token, site) {
  try {
    const [head, body, sig] = String(token).split('.');
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await pubKey(),
      unb64u(sig),
      new TextEncoder().encode(`${head}.${body}`),
    );
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (p.iss !== ISS || p.aud !== ZONE || !p.sub || !Array.isArray(p.scope) || !(p.exp > Date.now() / 1000)) return null;
    const owner = p.scope.includes('*');
    if (!owner && !(site && p.scope.includes(site))) return null;
    return { ...p, owner };
  } catch {
    return null;
  }
}

/** 从 Request（或 Cookie 头字符串）里取登录态并校验。site 省略 = 只认站长。 */
export async function ssoSession(requestOrCookieHeader, site) {
  const raw =
    typeof requestOrCookieHeader === 'string'
      ? requestOrCookieHeader
      : requestOrCookieHeader?.headers?.get?.('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SSO_COOKIE) return ssoVerify(part.slice(i + 1).trim(), site);
  }
  return null;
}

/** 去主站登录、登录完回到 returnTo 的地址。 */
export const ssoLoginUrl = (returnTo) => `${ISS}/login?next=${encodeURIComponent(returnTo)}`;
