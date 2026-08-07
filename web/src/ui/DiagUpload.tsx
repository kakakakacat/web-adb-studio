// 「上传诊断日志」按钮。
//
// 出现在两个地方：设备被占用那一页（问题正好发生的地方），和齿轮面板（其它情况）。
// 上传是**显式**的 —— 页面一直在本机记日志，但一个字节都不会自己发出去。
//
// 成功后给一个短 ID：排查时对方只需要报这一串，不用导文件、不用截图。

import { useState } from "react";

import { bundleVersion, snapshot, upload } from "../diag";
import { useStore } from "../store";
import { Icon } from "./Icon";

export function DiagUpload({ compact }: { compact?: boolean }) {
  const toast = useStore((s) => s.toast);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [id, setId] = useState<string | null>(null);

  /**
   * What the page believed at the moment of failure — usually the difference
   * between "no device" and "a device we can see but can't open".
   *
   * Read imperatively at click time, NOT through a selector: a selector that
   * builds an object returns a new identity on every call, and zustand's default
   * Object.is comparison then re-renders forever (React error #185 — it took the
   * whole page down, not just this button).
   */
  const collect = () => {
    const s = useStore.getState();
    return {
      devices: s.devices.map((d) => ({
        serial: d.serial,
        source: d.source,
        state: d.state,
        model: d.model,
      })),
      active: s.active ? { serial: s.active.device.serial, source: s.active.device.source } : null,
      blocked: s.blocked,
      serverReady: s.serverReady,
      backend: s.backend.kind,
      tab: s.tab,
      bridgeUrl: localStorage.getItem("adbstudio.bridgeUrl"),
    };
  };

  const send = async () => {
    setSending(true);
    try {
      const report = await snapshot(bundleVersion(), note, collect());
      const res = await upload(report);
      setId(res.id);
      toast("success", `已上传，编号 ${res.id}`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (id) {
    return (
      <div className="row">
        <Icon name="check" />
        <span>
          已上传，编号 <code className="mono">{id}</code>
        </span>
        <button
          className="btn sm ghost"
          onClick={() => {
            void navigator.clipboard.writeText(id).then(
              () => toast("success", "编号已复制"),
              () => toast("info", id),
            );
          }}
        >
          复制编号
        </button>
      </div>
    );
  }

  return (
    <div className="row">
      {!compact && (
        <input
          type="text"
          placeholder="出了什么问题？（可留空）"
          value={note}
          maxLength={200}
          style={{ flex: 1, minWidth: 180 }}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <button className="btn sm ghost" disabled={sending} onClick={() => void send()}>
        <Icon name="upload" />
        {sending ? "上传中…" : "上传诊断日志"}
      </button>
    </div>
  );
}
