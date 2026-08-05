// Gate for the two backend-only panels.
//
// Previously their buttons were simply disabled whenever the startup health check
// had failed, which is unhelpful twice over: you can't tell *why*, and a backend
// that came up later stays unreachable until the page is reloaded. Now the panels
// always open, probe on open, and say what happened — with a retry.

import { useCallback, useEffect, useState, type ReactNode } from "react";

import * as api from "../api";
import { Icon } from "./Icon";

type State = { kind: "probing" } | api.BackendStatus;

export function BackendGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "probing" });
  const [token, setToken] = useState("");

  const probe = useCallback(async () => {
    setState({ kind: "probing" });
    setState(await api.backendStatus());
  }, []);

  /** Save a token typed right here and re-probe — no detour via the settings. */
  const saveToken = useCallback(async () => {
    api.setApiToken(token.trim() || null);
    await probe();
  }, [token, probe]);

  /** A stale override (e.g. a hostname that no longer exists) breaks every
   *  backend call; offer the one-click way out rather than making people find
   *  the settings panel. */
  const base = api.apiBase();
  const clearOverride = useCallback(async () => {
    api.setApiBase(null);
    await probe();
  }, [probe]);

  useEffect(() => {
    void probe();
  }, [probe]);

  if (state.kind === "ok") return <>{children}</>;

  if (state.kind === "probing") {
    return (
      <div className="muted" style={{ padding: "34px 10px", textAlign: "center" }}>
        正在连接后端…
      </div>
    );
  }

  const unauthorized = state.kind === "unauthorized";
  return (
    <div style={{ padding: "22px 4px", textAlign: "center" }}>
      <div
        className="art"
        style={{
          display: "inline-grid",
          placeItems: "center",
          width: 56,
          height: 56,
          borderRadius: 16,
          background: "var(--surface-2)",
          color: "var(--warn)",
        }}
      >
        <Icon name={unauthorized ? "shield" : "cloud"} />
      </div>
      <h2 style={{ margin: "16px 0 6px", fontSize: 17 }}>
        {unauthorized ? "需要访问令牌" : "连不上后端"}
      </h2>
      <p className="muted" style={{ margin: "0 auto 16px", maxWidth: 430, fontSize: 13 }}>
        {unauthorized ? (
          <>
            服务在运行，但拒绝了请求。粘贴服务端 <code className="mono">server/.token</code>{" "}
            的内容（64 位十六进制）：
          </>
        ) : (
          <>
            此功能需要后端。{state.detail}
            {base && (
              <>
                <br />
                当前后端地址：<code className="mono">{base}</code>
              </>
            )}
          </>
        )}
      </p>

      {unauthorized && (
        <div className="row" style={{ maxWidth: 430, margin: "0 auto 14px" }}>
          <input
            type="password"
            className="mono"
            style={{ flex: 1 }}
            placeholder="访问令牌"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && token.trim()) void saveToken();
            }}
          />
          <button className="btn primary" disabled={!token.trim()} onClick={() => void saveToken()}>
            保存
          </button>
        </div>
      )}

      <div className="row" style={{ justifyContent: "center" }}>
        <button className="btn" onClick={() => void probe()}>
          <Icon name="refresh" />
          重试
        </button>
        {!unauthorized && base && (
          <button className="btn ghost" onClick={() => void clearOverride()}>
            改用同源
          </button>
        )}
      </div>
    </div>
  );
}
