#!/usr/bin/env node
// Verify the device side of 抓包 without a browser.
//
// The page reaches the collector with `adb.createSocket("localabstract:…")` over
// WebUSB, which needs a real browser window and a user gesture. The *protocol*
// underneath is the same either way, so this script uses the host `adb` to forward
// the very same abstract socket and decodes frames with an independent
// implementation of the format in src/adb/capture.ts. If this prints events, the
// device half works and anything left is UI.
//
// Usage:
//   node scripts/verify-netcapture.mjs [socketName] [seconds]

import { spawnSync } from "node:child_process";
import net from "node:net";

const socketName = process.argv[2] ?? "netcapture";
const seconds = Number(process.argv[3] ?? 20);
const port = 8791;

const adb = (...args) => {
  const r = spawnSync("adb", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`adb ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

console.log(`# 设备端 socket 列表`);
const unix = spawnSync("adb", ["shell", "cat /proc/net/unix"], { encoding: "utf8" }).stdout ?? "";
const listed = unix.split("\n").filter((l) => l.includes("netcapture"));
console.log(listed.length ? listed.join("\n") : "  (没有 netcapture socket —— 应用没跑，或装的是 release 包)");

adb("forward", `tcp:${port}`, `localabstract:${socketName}`);
console.log(`# adb forward tcp:${port} -> localabstract:${socketName}`);

const stats = { event: 0, blob: 0, control: 0, bytes: 0, kinds: {}, phases: {} };
let carry = Buffer.alloc(0);

const socket = net.connect(port, "127.0.0.1");
socket.on("connect", () => console.log(`# 已连接，抓 ${seconds} 秒\n`));
socket.on("error", (e) => {
  console.error(`连接失败：${e.message}`);
  finish(1);
});

socket.on("data", (chunk) => {
  stats.bytes += chunk.length;
  carry = Buffer.concat([carry, chunk]);
  for (;;) {
    if (carry.length < 4) return;
    const len = carry.readUInt32BE(0);
    if (len <= 0 || len > 8 * 1024 * 1024) {
      console.error(`帧长度不合法：${len}`);
      return finish(1);
    }
    if (carry.length < 4 + len) return;
    const type = carry[4];
    const payload = carry.subarray(5, 4 + len);
    carry = carry.subarray(4 + len);
    handle(type, payload);
  }
});

function handle(type, payload) {
  if (type === 1 || type === 3) {
    const json = JSON.parse(payload.toString("utf8"));
    if (type === 3) {
      stats.control++;
      console.log(`hello  ${json.pkg} pid=${json.pid} uid=${json.uid} socket=${json.socket}`);
      return;
    }
    stats.event++;
    stats.kinds[json.kind] = (stats.kinds[json.kind] ?? 0) + 1;
    stats.phases[`${json.kind}/${json.phase}`] = (stats.phases[`${json.kind}/${json.phase}`] ?? 0) + 1;
    console.log(summarize(json));
  } else if (type === 2) {
    stats.blob++;
    const refLen = payload.readUInt16BE(0);
    const ref = payload.subarray(2, 2 + refLen).toString("utf8");
    const truncatedFrom = payload.readInt32BE(2 + refLen);
    const bytes = payload.subarray(2 + refLen + 4);
    const head = bytes.subarray(0, 80).toString("utf8").replace(/[^\x20-\x7e]/g, ".");
    console.log(
      `  body ${ref} ${bytes.length}B${truncatedFrom > 0 ? ` (原 ${truncatedFrom}B)` : ""}  ${head}`
    );
  }
}

function summarize(e) {
  const at = `${e.kind}/${e.phase}`.padEnd(14);
  if (e.kind === "http" && e.phase === "start") return `${at} ${e.method} ${e.url}`;
  if (e.kind === "http" && e.phase === "end") return `${at} ${e.status} ${e.protocol} ${e.durMs}ms`;
  if (e.kind === "grpc" && e.phase === "start") return `${at} ${e.method} (${e.callType})`;
  if (e.kind === "grpc" && e.phase === "message") return `${at} ${e.dir} #${e.seq} ${e.len}B ${e.type ?? ""}`;
  if (e.kind === "grpc" && e.phase === "end") return `${at} ${e.code} ${e.durMs}ms up=${e.upCount} down=${e.downCount}`;
  if (e.kind === "ws") return `${at} ${e.url ?? ""}${e.dir ? `${e.dir} #${e.seq} ${e.len}B` : ""}`;
  return `${at} ${JSON.stringify(e).slice(0, 120)}`;
}

setTimeout(() => finish(0), seconds * 1000);

function finish(code) {
  console.log(`\n# 汇总`);
  console.log(`  事件 ${stats.event} · body ${stats.blob} · 共 ${stats.bytes} 字节`);
  for (const [k, v] of Object.entries(stats.phases)) console.log(`  ${k}: ${v}`);
  try {
    socket.destroy();
    adb("forward", "--remove", `tcp:${port}`);
  } catch {
    /* best effort */
  }
  const ok = stats.control > 0 && stats.event > 0;
  console.log(ok ? "\nPASS" : "\nFAIL —— 没收到事件（应用没有发网络请求？）");
  process.exit(code || (ok ? 0 : 1));
}
