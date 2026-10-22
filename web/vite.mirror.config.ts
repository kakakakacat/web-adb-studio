import { defineConfig } from "vite";

// 投屏挂件的单独产物（见 src/embed-mirror.ts）：一个文件，挂 window.DinoMirror。
//
// 为什么不复用主构建：主构建是整个 ADB Studio（React + 页签 + 文件 + 抓包…）。
// 家具配置台只要一块能动的画面，把那一整套塞给它既大又不相干。这里只打
// 「WebUSB 连接 + scrcpy 解码 + 触控」这条链路。
//
// **必须是单文件**（inlineDynamicImports）：宿主是个没有构建步骤的静态页面，
// 用 <script src> 引一个文件是它唯一能做的事；拆成 chunk 就得跟着搬一堆文件、
// 还要对上路径。
export default defineConfig({
  build: {
    target: "esnext",
    outDir: "dist-mirror",
    emptyOutDir: true,
    lib: {
      entry: "src/embed-mirror.ts",
      name: "DinoMirror",
      formats: ["iife"],
      fileName: () => "dino-mirror.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
