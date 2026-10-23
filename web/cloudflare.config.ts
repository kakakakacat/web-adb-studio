// cf CLI 的工程配置。本站原来是 Cloudflare Pages 项目，2026-10 改成 Worker + 静态资源：
// 新的 cf CLI 不支持 Legacy Pages，而 wrangler 的登录态已失效，站点因此发不出版本。
//
// 密钥不在这里，用 `cf secret put <名字>` 单独设：
//   PROXY_SECRET        与后端共享，后端只在它匹配时才采信转发过去的身份
//   DIAG_TOKEN          查看诊断报告的口令（没配 = 查看接口关闭，上传照常）
//   DIAG_SALT           诊断报告里 ip_hash 的盐（没配就用固定值）
import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  accountId: "cc05c4c38d992a07dce258cd8ee5e32a",
  worker: {
    name: "adb-studio",
    compatibilityDate: "2026-08-05",
    entrypoint: "src/worker/index.ts",
    domains: ["adb.kakacat.net"],
    assets: {
      notFoundHandling: "single-page-application",
      // 这两条由 Worker 处理，不能被静态资源抢走。
      // 裸路径要单列：`/diag/*` 匹配不到 `/diag` 本身（列表页就落到 index.html 上了）。
      runWorkerFirst: ["/api", "/api/*", "/diag", "/diag/*"],
    },
    env: {
      // tunnel 后面的后端主机名。原来没设这个变量，代码里的默认值又指向已失效的
      // api-adb.kakacat.icu，于是 /api/* 全程 530 —— 写进配置，别再靠默认值。
      API_ORIGIN: bindings.text("api-adb.kakacat.net"),
      adbstudio_diag: bindings.d1({
        name: "adbstudio-diag",
        id: "325f8eb9-9a04-4de0-8615-3d9b880dde63",
      }),
      ASSETS: bindings.assets(),
      PROXY_SECRET: bindings.secret(),
      DIAG_TOKEN: bindings.secret(),
      DIAG_SALT: bindings.secret(),
    },
  },
});
