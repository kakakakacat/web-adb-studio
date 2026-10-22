// kakacat-sso.js 的类型声明（验签库原样从 kakacat-home/sso/verify.js 复制，保持 JS 不改）。

export interface SsoJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  kid?: string;
}

export interface SsoClaims {
  iss: string;
  aud: string;
  /** "owner" 或访客邮箱 */
  sub: string;
  scope: string[];
  iat: number;
  exp: number;
  amr: string[];
  /** scope 含 "*" */
  owner: boolean;
  /** 本站内部的角色（user / readonly / admin），由主站 grants 决定 */
  role: string;
  /** owner | user | share（访问码换来的登录态） */
  kind: string;
  /** 显示用身份：访问码的 as_name，或账号名 */
  who: string;
  /** 这枚登录态的唯一 id，主站用它吊销 */
  jti?: string;
}

export declare const SSO_COOKIE: string;
export declare const PUBLIC_JWK: SsoJwk;
export declare function ssoVerify(token: string, site?: string, jwk?: SsoJwk): Promise<SsoClaims | null>;
export declare function ssoSession(requestOrCookieHeader: Request | string, site?: string, jwk?: SsoJwk): Promise<SsoClaims | null>;
export declare function ssoLoginUrl(returnTo: string): string;
/** 没登录态时该去哪儿：先静默续签，续过一轮（URL 带 _kc）还不行才去登录页 */
export declare function ssoChallenge(url: string): string;
/** 续签回来后把 _kc 痕迹擦掉；不用跳转返回 null */
export declare function ssoCleanUrl(url: string): string | null;
export declare function ssoReport(request: Request, session: SsoClaims | null, detail?: string): Promise<void>;
