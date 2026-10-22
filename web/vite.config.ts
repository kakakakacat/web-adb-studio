import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";

import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The Rust backend (SFTP / Dino gRPC / mDNS / ws-tcp relay) that the browser
// can't replace. In dev it runs on :7070; in production the same origin serves
// both the static bundle and /api, so no proxy is needed.
const BACKEND = process.env.ADBSTUDIO_BACKEND ?? "http://127.0.0.1:7070";

/**
 * bridge 二进制随产物一起发。
 *
 * 它们是纯静态文件，原来由内网后端在 /download 下提供；放到边缘，下载一个中转程序
 * 就不用去打扰 NAS 了。原先这段逻辑在 deploy-pages.sh 里，站点从 Pages 改成 Worker
 * 之后那个脚本没了，挂到构建上 —— 谁触发构建都不会漏掉。
 */
function bridgeDownloads(): Plugin {
  const src = process.env.BRIDGE_DIR ?? "../server/bridge-dist";
  return {
    name: "adbstudio-bridge-downloads",
    apply: "build",
    // 构建前放进 publicDir，让它跟其他静态文件走同一条路进产物
    // （产物目录由 Cloudflare 插件接管，不再是 dist/，所以不能构建后再往那儿拷）。
    buildStart() {
      if (!existsSync(src)) {
        this.warn(`${src} 不存在，页面里的桥接下载链接会 404`);
        return;
      }
      mkdirSync("public/download", { recursive: true });
      for (const name of readdirSync(src)) cpSync(`${src}/${name}`, `public/download/${name}`);
    },
  };
}

export default defineConfig({
  // cloudflare()：Worker（src/worker/index.ts，配置在 cloudflare.config.ts）和静态
  // 产物由同一次构建产出。本地 `cf dev` 时 /api 和 /diag 直接由同进程的 Worker 处理。
  plugins: [react(), cloudflare(), bridgeDownloads()],
  server: {
    port: 1421,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true, ws: true },
    },
  },
  build: {
    // Tango uses modern syntax (private fields, top-level await in workers).
    target: "esnext",
  },
  worker: { format: "es" },
});
