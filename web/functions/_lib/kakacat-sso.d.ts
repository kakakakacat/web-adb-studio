// kakacat-sso.js 的类型声明（验签库原样从 kakacat-home/sso/verify.js 复制，保持 JS 不改）。

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
}

export declare const SSO_COOKIE: string;
export declare function ssoVerify(token: string, site?: string): Promise<SsoClaims | null>;
export declare function ssoSession(requestOrCookieHeader: Request | string, site?: string): Promise<SsoClaims | null>;
export declare function ssoLoginUrl(returnTo: string): string;
