import { useEffect, useState } from "react";

import { isSplitDeployment, signIn } from "./api";
import { useStore, type Tab } from "./store";
import { Apps } from "./ui/Apps";
import { Device } from "./ui/Device";
import { Files } from "./ui/Files";
import { Help } from "./ui/Help";
import { Icon } from "./ui/Icon";
import { Logcat } from "./ui/Logcat";
import { Mirror } from "./ui/Mirror";
import { Net } from "./ui/Net";
import { Sidebar } from "./ui/Sidebar";
import { BusyOverlay, Toasts } from "./ui/Toasts";

// "概览" and "工具" were each half a screen of facts and buttons, so they live
// together on 设备. 投屏 and 日志 get their own pages because both want the full
// height and neither fits the card-grid layout.
const TABS: { key: Tab; label: string }[] = [
  { key: "device", label: "设备" },
  { key: "apps", label: "应用" },
  { key: "files", label: "文件" },
  { key: "mirror", label: "投屏" },
  { key: "logcat", label: "日志" },
  { key: "net", label: "抓包" },
];

type Panel = "help" | null;

export function App() {
  const init = useStore((s) => s.init);
  const watchDevices = useStore((s) => s.watchDevices);
  const active = useStore((s) => s.active);
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const disconnect = useStore((s) => s.disconnect);
  const signOut = useStore((s) => s.signOut);
  const refreshIdentity = useStore((s) => s.refreshIdentity);
  const [panel, setPanel] = useState<Panel>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  // Cloudflare Access logs you in silently once an IdP session exists, so this is
  // the only visible confirmation of which identity is in use.
  const user = useStore((s) => s.health?.user ?? null);
  // A sign-in exists to offer only when the deployment has one and the visitor
  // hasn't used it.
  // health 拿不到时也要给出登录入口 —— 拆分部署下 API 一定挂着 Cloudflare Access，
  // 所以「探测失败」不等于「这个部署没有登录」。
  //
  // 之前的写法在 health 为 null 时把 needsLogin 算成 false，于是后端一旦探测失败，
  // 页面上唯一的登录入口就**无声消失**，用户既不知道发生了什么也没有别的路可走
  // （实测：切换到 Pages 之后，一个没刷新过的旧标签页正好落进这个状态）。
  const needsLogin = useStore((s) => {
    if (s.health) return s.health.features.accessIdentity && !s.health.user;
    return isSplitDeployment();
  });
  const backendUnreachable = useStore((s) => s.health === null);

  useEffect(() => {
    void init();
  }, [init]);

  // Coming back from the sign-in/sign-out round trip often means a restore from
  // the back/forward cache: no reload, no init(), and whatever was on screen when
  // we left comes back with it — including entry points the identity behind them
  // may no longer exist for. Re-ask on every restore.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) void refreshIdentity();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [refreshIdentity]);

  // Clicking anywhere else dismisses the account menu, the way every other menu
  // in a browser behaves.
  useEffect(() => {
    if (!accountOpen) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest(".who-wrap")) setAccountOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [accountOpen]);

  // Hot-plug: the page keeps its own list in sync instead of waiting for someone
  // to press refresh. WebUSB fires connect/disconnect events, and the adb server
  // pushes its device list over host:track-devices — whichever transport is in
  // play, swapping a phone should just work.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void watchDevices().then((fn) => {
      if (cancelled) fn();
      else stop = fn;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [watchDevices]);

  return (
    <>
      <div className="app">
        <div className="brand">
          <span className="dot" />
          ADB Studio
        </div>

        <div className="topbar">
          {active ? (
            <div className="tabs">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  className={`tab ${tab === t.key ? "on" : ""}`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ) : (
            <span className="muted" style={{ paddingLeft: 14 }}>
              未连接设备
            </span>
          )}

          <div className="row">
            {user ? (
              <div className="who-wrap">
                <button
                  className="who"
                  title={`已登录：${user}`}
                  onClick={() => setAccountOpen((v) => !v)}
                >
                  {user.slice(0, 1).toUpperCase()}
                </button>
                {accountOpen && (
                  <div className="who-menu">
                    <div className="addr">{user}</div>
                    <button
                      className="btn sm ghost"
                      onClick={() => {
                        setAccountOpen(false);
                        // An internal panel left open would outlive the identity
                        // that was allowed to see it.
                        setPanel((p) => (p === "help" ? p : null));
                        void signOut();
                      }}
                    >
                      <Icon name="power" />
                      退出登录
                    </button>
                  </div>
                )}
              </div>
            ) : (
              // Only offered where signing in can actually unlock something. A
              // local run has no identity provider, and dangling a login there
              // would be an invitation to a dead end.
              needsLogin && (
                <button
                  className="btn sm ghost"
                  title={
                    backendUnreachable
                      ? "连不上后端（可能是缓存的旧页面）—— 先硬刷新一次；仍然失败请看「连接方式 / 环境自检」"
                      : "登录后可使用需要身份的功能（本仓库不含，见 README）"
                  }
                  onClick={() => signIn()}
                >
                  <Icon name="shield" />
                  登录解锁
                </button>
              )
            )}
            <button className="btn sm ghost" onClick={() => setPanel("help")} title="连接方式 / 环境自检">
              <Icon name="settings" />
            </button>
            {active && (
              <button className="btn sm" onClick={() => void disconnect()} title="断开设备">
                <Icon name="power" />
              </button>
            )}
          </div>
        </div>

        <Sidebar />

        <main className="main">
          {!active ? (
            <div className="empty">
              <div className="box">
                <div className="art">
                  <Icon name="usb" />
                </div>
                <h2>连接一台设备</h2>
                <p>插上手机，点左下角按钮授权即可。</p>
                <button className="btn ghost" onClick={() => setPanel("help")}>
                  <Icon name="settings" />
                  连接方式 / 环境自检
                </button>
              </div>
            </div>
          ) : tab === "device" ? (
            <Device active={active} />
          ) : tab === "apps" ? (
            <Apps active={active} />
          ) : tab === "files" ? (
            <Files active={active} />
          ) : tab === "logcat" ? (
            // Keyed by serial so switching devices kills the old stream via the
            // unmount cleanup rather than leaving it running.
            <Logcat key={active.device.serial} active={active} />
          ) : tab === "net" ? (
            // Same reason as 日志, and here it matters more: an orphaned capture
            // socket keeps the app's collector believing someone is subscribed.
            <Net key={active.device.serial} active={active} />
          ) : (
            // Keyed by serial so switching devices unmounts the session and its
            // cleanup runs, instead of reusing a canvas bound to the old device.
            <Mirror key={active.device.serial} active={active} />
          )}
        </main>
      </div>

      {panel === "help" && <Help onClose={() => setPanel(null)} />}

      <Toasts />
      <BusyOverlay />
    </>
  );
}
