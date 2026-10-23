// 把 /api/* 转发到 tunnel 后面的后端。
//
// 存在的理由：页面本体是边缘分发的静态资源（陌生人不碰后端那台机器），而 API 只能从
// 内网机器经 cloudflared 出来。一个主机名只能指向一个源，所以要让访客只看见一个域名，
// 就得有人在边缘把 /api/* 接过去。
//
// 本来更合适的工具是 Cloudflare 的 Origin Rules（无代码、无额外延迟），但它的
// Host/SNI/DNS 覆盖是**企业版功能**，Free 版只能改端口。所以由本 Worker 来接。
//
// ## 身份怎么传下去
//
// 身份来自 kakacat.net 签发的 kc_session（ES256，公钥内置在 _lib/kakacat-sso.js，
// 验签不过就不转发任何身份）。scope 含 adb 才算数：站长和 deepmirror.com 访客都有，
// 后者进不了别的子站。没有身份时后端对内部功能一律 403，所以这里只需要把「去登录」
// 那一跳（/api/auth/login）接到 kakacat.net。
//
// 邮箱用自有头名 `x-adbstudio-user` 转发，并附上共享密钥 PROXY_SECRET；后端只在
// 密钥匹配时才采信这个头 —— 否则任何人对着 tunnel 主机名就能伪造身份。
//
// 2026-10 摘掉了原先挡在 /api/{auth,remote,dino} 前面的 Cloudflare Access 应用
// 及这里对它的 JWT 验签：后端早已改成只认 x-adbstudio-user + 密钥，不再读
// cf-access-authenticated-user-email，那条路已经是死代码。

import { ssoSession, ssoChallenge } from "./kakacat-sso.js";

/** 站长在后端白名单里的邮箱（ADBSTUDIO_ACCESS_EMAILS）。 */
const OWNER_EMAIL = "1046376300mod@gmail.com";

export interface Env {
  /** tunnel 后面的后端主机名，例如 api-adb.kakacat.net。 */
  API_ORIGIN?: string;
  /** 与后端共享的密钥，后端只在它匹配时才采信 x-adbstudio-user。Worker secret，不进仓库。 */
  PROXY_SECRET?: string;
}

// 旧值是 api-adb.kakacat.icu —— 那个域名已失效，而线上又没设 API_ORIGIN，
// 于是 /api/* 全程 530。默认值必须是一个真的能解析的主机名。
const DEFAULT_ORIGIN = "api-adb.kakacat.net";

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(
    incoming.pathname + incoming.search,
    `https://${env.API_ORIGIN ?? DEFAULT_ORIGIN}`
  );

  const headers = new Headers(request.headers);
  // Host 跟着目标 URL 走（Workers 里手工设 Host 是无效的，路由由 URL 决定），
  // cloudflared 就是按 hostname 匹配 ingress 的。
  headers.set("Host", target.host);

  // 身份：验签通过才转发，且换成自有头名。
  let email: string | null = null;
  const session = await ssoSession(request, "adb");
  if (session) email = session.owner ? OWNER_EMAIL : String(session.sub).toLowerCase();
  // 未登录点「登录」：去 kakacat.net，回来时再走一遍这里，后端按 redirect_url 送回原页面。
  // 主站的访问态只有 30 分钟，所以先试静默续签，续过一轮还不行才会落到登录页。
  if (!session && incoming.pathname === "/api/auth/login") {
    return Response.redirect(ssoChallenge(incoming.toString()), 302);
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

  if (env.PROXY_SECRET) headers.set("x-adbstudio-proxy", env.PROXY_SECRET);
  // 这两个头由 Cloudflare 在**下一跳**重新计算；照抄过去会自相矛盾。
  headers.delete("cf-connecting-ip");
  headers.delete("x-forwarded-for");

  // WebSocket（/api/adb 是 adb 中继）不能当普通 fetch 处理：要把 101 和那对 socket
  // 原样传回去，否则升级会在这里被吃掉。
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    const upstream = await fetch(target.toString(), {
      method: request.method,
      headers,
      body: request.body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
      webSocket: (upstream as unknown as { webSocket?: WebSocket }).webSocket,
    } as ResponseInit & { webSocket?: WebSocket });
  }

  const upstream = await fetch(target.toString(), {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "manual",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
