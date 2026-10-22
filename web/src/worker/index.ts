// ADB Studio 的边缘 Worker：页面本体是静态资源，另外接两条路径。
//
//   /api/*   → 转发到 tunnel 后面的内网后端（见 api-proxy.ts）
//   /diag/*  → 诊断报告的收集与查看，就地处理（见 diag.ts）
//   其余     → 静态资源，404 回落到 index.html（SPA）
//
// 原来这是一个 Cloudflare Pages 项目，两条路径是 Pages Functions。改成 Worker 的
// 原因很实际：新的 cf CLI 不支持 Legacy Pages（`cf pages deploy` 直接拒绝），
// 而这台机器上 wrangler 的登录态已经失效，结果就是这个站**发不出版本** —— 线上
// /api/* 一直 530（默认后端主机名指向已失效的 kakacat.icu），却改不了。

import { handleApi, type Env as ApiEnv } from "./api-proxy";
import { handleDiagGet, handleDiagPost, type DiagEnv } from "./diag";

export interface Env extends ApiEnv, DiagEnv {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api" || pathname.startsWith("/api/")) return handleApi(request, env);

    if (pathname === "/diag" || pathname.startsWith("/diag/")) {
      if (request.method === "POST") return handleDiagPost(request, env);
      if (request.method === "GET" || request.method === "HEAD") {
        // Pages 的 [[path]] 捕获参数在 Worker 里要自己从路径里取
        const parts = pathname.slice("/diag".length).split("/").filter(Boolean);
        return handleDiagGet(request, env, parts);
      }
      return new Response("方法不被允许", { status: 405 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
