// Device page — the old "概览" and "工具" tabs merged.
//
// They were two half-empty screens: a few facts and a handful of buttons each.
// Together they fill one screen at a comfortable size, which is what a
// full-screen browser window wants.

import { useEffect, useState } from "react";

import * as device from "../adb/device";
import { KEYCODES, keyevent, screenshot, screenshotToDownload, sendText } from "../adb/media";
import { useStore, type Active } from "../store";
import { errorMessage, type RebootMode } from "../types";
import { Icon, Tile } from "./Icon";

function Stat({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${mono ? "mono" : ""}`}>{v}</div>
    </div>
  );
}

export function Device({ active }: { active: Active }) {
  const toast = useStore((s) => s.toast);
  const reloadInfo = useStore((s) => s.reloadInfo);
  const restartAdbd = useStore((s) => s.restartAdbd);
  const runOnDevice = useStore((s) => s.runOnDevice);
  const [buildType, setBuildType] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [text, setText] = useState("");
  const info = active.info;

  useEffect(() => {
    let alive = true;
    void device
      .buildType(active.adb)
      .then((t) => alive && setBuildType(t))
      .catch(() => alive && setBuildType(null));
    return () => {
      alive = false;
    };
  }, [active.adb]);

  useEffect(() => {
    return () => {
      if (shot) URL.revokeObjectURL(shot);
    };
  }, [shot]);

  const rootable = buildType !== null && buildType !== "user";

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      const out = await fn();
      const msg = typeof out === "string" && out.trim() ? out.trim() : `${label}完成`;
      toast("success", msg);
    } catch (e) {
      toast("error", `${label}失败：${errorMessage(e)}`);
    }
  }

  function confirmRun(label: string, question: string, fn: () => Promise<unknown>) {
    if (!confirm(question)) return;
    void run(label, fn);
  }

  const reboots: { mode: RebootMode; label: string; icon: string }[] = [
    { mode: "system", label: "重启", icon: "restart" },
    { mode: "recovery", label: "Recovery", icon: "shield" },
    { mode: "bootloader", label: "Bootloader", icon: "power" },
    { mode: "fastboot", label: "Fastboot", icon: "play" },
  ];

  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 1fr)" }}>
      <div className="stack">
        <div className="card">
          <div className="hero">
            <div className="art">
              <Icon name="phone" />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="big">{info?.model ?? active.device.name}</div>
              <div className="sub">{active.device.serial}</div>
            </div>
            <button
              className="btn sm ghost"
              style={{ marginLeft: "auto" }}
              onClick={() => void reloadInfo()}
              title="重新读取设备信息"
            >
              <Icon name="refresh" />
            </button>
          </div>

          <div className="stats">
            <Stat k="品牌" v={info?.brand ?? "—"} />
            <Stat
              k="Android"
              v={info ? `${info.androidVersion ?? "—"}${info.sdkVersion ? ` (${info.sdkVersion})` : ""}` : "—"}
            />
            <Stat k="ABI" v={info?.abi ?? "—"} mono />
            <Stat k="构建" v={buildType ?? "—"} mono />
            <Stat
              k="Bootloader"
              v={
                info?.bootloaderUnlocked === undefined
                  ? "未知"
                  : info.bootloaderUnlocked
                    ? "已解锁"
                    : "已锁定"
              }
            />
            <Stat
              k="连接"
              v={active.device.source === "bridge" ? "adb 桥接" : "WebUSB"}
            />
          </div>

        </div>

        <div className="card">
          <h3>电源与权限</h3>
          <div className="tiles">
            {reboots.map((r) => (
              <Tile
                key={r.mode}
                icon={r.icon}
                label={r.label}
                onClick={() =>
                  confirmRun(r.label, `确定要${r.label}设备吗？`, () =>
                    device.reboot(active.adb, r.mode)
                  )
                }
              />
            ))}
            <Tile
              icon="shield"
              label="root"
              disabled={!rootable}
              title={rootable ? "adb root" : `构建类型 ${buildType ?? "?"}，不允许 root`}
              onClick={() => void run("root", () => restartAdbd("root"))}
            />
            <Tile
              icon="wrench"
              label="remount"
              disabled={!rootable}
              title={rootable ? "adb remount" : `构建类型 ${buildType ?? "?"}，不允许 remount`}
              // remount does not restart adbd, but the transport it runs on may
              // already be stale from an earlier root — so it retries too.
              onClick={() => void run("remount", () => runOnDevice("remount", device.remount))}
            />
          </div>
        </div>
      </div>

      <div className="stack">
        <div className="card">
          <h3>截图</h3>
          <div className="tiles" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
            <Tile
              icon="eye"
              label="预览"
              tone="accent"
              onClick={() =>
                void screenshot(active.adb)
                  .then((b) => setShot(URL.createObjectURL(b)))
                  .catch((e) => toast("error", errorMessage(e)))
              }
            />
            <Tile
              icon="download"
              label="保存"
              onClick={() =>
                void screenshotToDownload(active.adb, info?.model ?? active.device.name).catch((e) =>
                  toast("error", errorMessage(e))
                )
              }
            />
          </div>
          {shot && (
            <img
              src={shot}
              alt="设备截图"
              style={{
                marginTop: 16,
                width: "100%",
                maxHeight: 420,
                objectFit: "contain",
                borderRadius: 14,
                background: "var(--surface-2)",
              }}
            />
          )}
        </div>

        <div className="card">
          <h3>输入</h3>
          <div className="row">
            <input
              type="text"
              style={{ flex: 1 }}
              placeholder="输入文本发送到设备"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && text) {
                  void run("发送文本", async () => {
                    await sendText(active.adb, text);
                    setText("");
                  });
                }
              }}
            />
            <button
              className="btn primary"
              disabled={!text}
              onClick={() =>
                void run("发送文本", async () => {
                  await sendText(active.adb, text);
                  setText("");
                })
              }
            >
              <Icon name="send" />
              发送
            </button>
          </div>

          <div className="tiles" style={{ marginTop: 14 }}>
            {(
              [
                ["返回", "back", KEYCODES.back],
                ["主屏", "home", KEYCODES.home],
                ["任务", "square", KEYCODES.appSwitch],
                ["回车", "enter", KEYCODES.enter],
                ["删除", "del", KEYCODES.del],
                ["音量+", "volumeUp", KEYCODES.volumeUp],
                ["音量−", "volumeDown", KEYCODES.volumeDown],
                ["亮屏", "sun", KEYCODES.wakeup],
                ["息屏", "moon", KEYCODES.sleep],
                ["电源", "power", KEYCODES.power],
              ] as const
            ).map(([label, icon, code]) => (
              <Tile
                key={code}
                icon={icon}
                label={label}
                onClick={() => void run(label, () => keyevent(active.adb, code))}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
