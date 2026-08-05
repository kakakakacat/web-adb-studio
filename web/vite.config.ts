import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Rust backend (SFTP / Dino gRPC / mDNS / ws-tcp relay) that the browser
// can't replace. In dev it runs on :7070; in production the same origin serves
// both the static bundle and /api, so no proxy is needed.
const BACKEND = process.env.ADBSTUDIO_BACKEND ?? "http://127.0.0.1:7070";

export default defineConfig({
  plugins: [react()],
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
