// Environment self-check + the choice between the two connection paths.
//
// This panel exists because the two failure modes people actually hit are
// invisible otherwise: the page served over plain http (WebUSB simply doesn't
// exist) and a local adb server holding the USB interface.

import { useState } from "react";

import * as server from "../adb/server";
import { secureContextOk, webUsbSupported } from "../adb/session";
import { webCodecsSupported } from "../adb/scrcpy";
import * as api from "../api";
import { useStore } from "../store";
import { errorMessage } from "../types";
import { Icon } from "./Icon";
import { Modal } from "./Modal";

/**
 * A row of the self-check.
 *
 * `ok: null` is "not applicable here", and it exists so an optional capability
 * can't masquerade as a fault. The bridge row used to go red on any machine
 * without its own bridge, which made a perfectly working WebUSB-only setup look
 * broken.
 */
function Check({
  ok,
  label,
  detail,
}: {
  ok: boolean | null;
  label: string;
  detail?: string;
}) {
  return (
    <div className="list-row">
      <span className={`pill ${ok === null ? "" : ok ? "ok" : "bad"}`}>
        {ok === null ? "不适用" : ok ? "OK" : "缺失"}
      </span>
      <div className="grow">
        <div>{label}</div>
        {detail && <div className="muted mono">{detail}</div>}
      </div>
    </div>
  );
}

/** Backend row: an invalid token must not read as "the service is down". */
function backendCheck(status: import("../api").BackendStatus) {
  switch (status.kind) {
    case "ok":
      return {
        ok: true,
        detail: `v${status.health.version} · adb server ${status.health.adbServer}`,
      };
    case "unauthorized":
      return {
        ok: false,
        detail:
          "令牌无效或缺失（服务在跑，但拒绝了请求）。请在下方填入服务端 server/.token 的内容 —— 64 位十六进制，不是 Cloudflare 的 cfut_… token。",
      };
    case "unreachable":
      return {
        ok: false,
        detail: `无法连接后端（${status.detail}）：可能未启动、地址填错，或被浏览器拦截。USB 功能仍可正常使用。`,
      };
  }
}

export function Help({ onClose }: { onClose(): void }) {
  const health = useStore((s) => s.health);
  const backend = useStore((s) => s.backend);
  const serverReady = useStore((s) => s.serverReady);
  const toast = useStore((s) => s.toast);
  const init = useStore((s) => s.init);

  const [bridge, setBridge] = useState(server.bridgeOverride() ?? "");
  const bridgeConfigured = bridge !== "";
  const guessed = server.guessBridgeBuild();
  const [checking, setChecking] = useState(false);
  const [base, setBase] = useState(api.apiBase());
  const [token, setToken] = useState(api.apiToken() ?? "");
  const [savingBackend, setSavingBackend] = useState(false);

  async function saveBackend() {
    api.setApiBase(base.trim() || null);
    api.setApiToken(token.trim() || null);
    setSavingBackend(true);
    try {
      await init();
      const h = await api.health();
      toast(
        h ? "success" : "error",
        h ? "后端连接正常" : "后端不可达或令牌错误"
      );
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setSavingBackend(false);
    }
  }

  async function applyBridge(url: string | null) {
    server.setBridgeOverride(url);
    setBridge(url ?? "");
    setChecking(true);
    try {
      await init();
      const ok = await server.serverAvailable();
      toast(
        ok ? "success" : "error",
        ok ? "已连上 adb 桥接" : "桥接不可达：确认服务端已启动，且 adb server 在运行"
      );
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Modal
      title="连接方式与环境自检"
      subtitle="两条通路都能用，连上之后功能完全一样"
      onClose={onClose}
    >
      <div className="list" style={{ marginBottom: 16 }}>
        <Check
          ok={secureContextOk()}
          label="安全上下文（HTTPS 或 localhost）"
          detail={
            secureContextOk()
              ? window.location.origin
              : "WebUSB 在普通 http:// 下不存在，必须用 HTTPS 或 localhost 访问"
          }
        />
        <Check
          ok={webUsbSupported()}
          label="浏览器支持 WebUSB"
          detail={webUsbSupported() ? undefined : "请使用 Chrome / Edge 等 Chromium 浏览器"}
        />
        <Check
          ok={webCodecsSupported()}
          label="WebCodecs 硬解码（投屏需要）"
        />
        <Check label="后端服务" {...backendCheck(backend)} />
        <Check
          // A deployment without Access has no identity to show; calling that
          // "missing" made a healthy local run look broken.
          ok={health?.user ? true : health?.features.accessIdentity ? false : null}
          label="登录身份（Cloudflare Access）"
          detail={
            health?.user ??
            (health?.features.accessIdentity
              ? "本部署要求登录，但这次请求没带身份"
              : "本部署没有配置登录（本机直连时属正常）")
          }
        />
        <Check
          // Optional, not required: WebUSB is the zero-install path and needs
          // none of this. Only call it missing when a bridge was explicitly
          // pointed at and then failed.
          ok={serverReady ? true : bridgeConfigured ? false : null}
          label="adb 桥接（可选，用于和 Android Studio 共存）"
          detail={
            serverReady
              ? undefined
              : bridgeConfigured
                ? `连不上 ${bridge} —— 桥接没在跑？`
                : "本部署没有 adb server，用 WebUSB 直连即可，不需要它"
          }
        />
      </div>

      <h3>方式一：WebUSB 直连（零安装，换台电脑打开网页就能用）</h3>
      <p className="muted">
        插上手机，点“连接 USB 设备”，在弹出的列表里选中它，再在手机上允许 USB
        调试即可。这台电脑上<strong>不需要装任何东西</strong> —— 不用 adb，不用
        Android SDK，也不用本项目的源码。
      </p>
      <p className="muted">
        唯一的前提：这台电脑上不能有 adb server 正占着这台手机。USB
        调试接口是独占的，浏览器和 adb 只能有一个拿到它。所以如果这台机器开着
        Android Studio 或用过终端 <code className="mono">adb</code>，就会提示设备被占用
        —— 那种情况只能用下面的方式二。Windows 上还要求该设备的 ADB 接口绑定 WinUSB
        驱动。
      </p>

      <h3>方式二：本机 adb 桥接（需要在那台电脑上跑一个程序）</h3>
      <p className="muted">
        只有一个用途：<strong>和 Android Studio 同时用一台设备</strong>。代价是那台
        电脑上要跑一个小程序（下面可以直接下载，免安装），做不到“打开网页就能用”。
        浏览器无法直接连 adb 的 TCP 5037 端口，所以这一步没法省掉。
      </p>
      <p className="muted">
        在自己电脑上跑一个桥接，网页通过 WebSocket 连它，它再连本机的{" "}
        <code className="mono">adb server:5037</code>。占用 USB 接口的始终只有 adb
        server 一个，而它本身就是为多客户端设计的，所以网页、终端 adb、Android
        Studio 可以<strong>同时</strong>用同一台设备，不需要 kill-server。
      </p>
      <p className="muted" style={{ marginBottom: 6 }}>
        下载对应系统的桥接程序，运行它，开着不用管：
      </p>
      <div className="row" style={{ flexWrap: "wrap", marginBottom: 6 }}>
        {server.BRIDGE_BUILDS.map((b) => {
          const mine = guessed?.file === b.file;
          return (
            <a
              key={b.file}
              className={`btn sm${mine ? " primary" : ""}`}
              href={server.bridgeDownloadUrl(b.file)}
              download
              title={b.note}
            >
              <Icon name="download" />
              {b.label}
              {mine && " ·  你的系统"}
            </a>
          );
        })}
      </div>
      {guessed?.note && (
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          {guessed.note}
        </p>
      )}
      <p className="muted" style={{ fontSize: 12 }}>
        有源码的话也可以直接 <code className="mono">./scripts/bridge.sh</code>，是同一个东西。
      </p>
      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="btn primary"
          disabled={checking}
          onClick={() => void applyBridge(server.LOCAL_BRIDGE_URL)}
        >
          {checking ? "检测中…" : "用本机桥接"}
        </button>
        {bridge && (
          <button className="btn" disabled={checking} onClick={() => void applyBridge(null)}>
            改回同源（{window.location.host}）
          </button>
        )}
        <span className="muted" style={{ fontSize: 12 }}>
          当前：{bridge || `同源 ${window.location.host}`}
        </span>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        第一次连接时 Chrome 会弹窗询问「访问本地网络」—— 必须点允许。这是 Chrome 的
        Local Network Access 检查，拦的是公网页面连 127.0.0.1；点过一次就会记住。
      </p>
      <div className="row" style={{ marginTop: 4 }}>
        <input
          type="text"
          className="mono"
          style={{ flex: 1 }}
          placeholder={`桥接地址，留空则用同源后端（${window.location.host}）`}
          value={bridge}
          onChange={(e) => setBridge(e.target.value)}
        />
        <button
          className="btn"
          disabled={checking}
          onClick={() => void applyBridge(bridge.trim() || null)}
        >
          保存并重连
        </button>
      </div>

      <p className="muted" style={{ fontSize: 12 }}>
        同一台设备若两条通路都能看到，列表里只显示桥接那一个 —— 它不会和本机 adb 抢接口。
      </p>

      <h3>后端地址与访问令牌</h3>
      <p className="muted">
        页面与后端不同源时（例如页面托管在 Cloudflare Pages、后端经 Tunnel 暴露）在这里填。
        留空表示同源。令牌对应服务端的 <code className="mono">ADBSTUDIO_TOKEN</code>；
        服务端只要不是仅监听 127.0.0.1，就必须设令牌才会启动。
      </p>
      <div className="row">
        <input
          type="text"
          className="mono"
          style={{ flex: 1 }}
          placeholder="留空 = 同源，或 https://adb.example.com"
          value={base}
          onChange={(e) => setBase(e.target.value)}
        />
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input
          type="password"
          className="mono"
          style={{ flex: 1 }}
          placeholder="访问令牌 = server/.token 的内容（64 位十六进制）"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button className="btn primary" disabled={savingBackend} onClick={() => void saveBackend()}>
          {savingBackend ? "检测中…" : "保存并检测"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        令牌存在浏览器本地。分享链接可用{" "}
        <code className="mono">https://…/#token=xxx&api=https://…</code>
        ，打开后会自动保存并从地址栏清除。
      </p>
      <p className="muted" style={{ fontSize: 12 }}>
        别和 Cloudflare 的 API token（<code className="mono">cfut_…</code>
        ，只用于签发证书）搞混 —— 这里要的是服务端{" "}
        <code className="mono">server/.token</code> 里那串 64 位十六进制。
      </p>
    </Modal>
  );
}
