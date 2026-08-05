// Log viewer.
//
// Kept deliberately plain (dense monospace rows, no cards) because the value here
// is scanning a lot of text quickly. The design language applies to the controls.

import { useCallback, useEffect, useRef, useState } from "react";

import * as apps from "../adb/apps";
import * as logcat from "../adb/logcat";
import { useStore, type Active } from "../store";
import { errorMessage } from "../types";
import { Icon } from "./Icon";

/** Ring buffer size. Enough to scroll back through, small enough to stay fast. */
const MAX_LINES = 5000;
/** Only the tail is rendered; the rest stays in memory for filtering/export. */
const RENDER_LIMIT = 800;

const LEVELS: logcat.LogLevel[] = ["V", "D", "I", "W", "E", "F"];
const LEVEL_LABEL: Record<logcat.LogLevel, string> = {
  V: "全部",
  D: "Debug",
  I: "Info",
  W: "Warn",
  E: "Error",
  F: "Fatal",
};

export function Logcat({ active }: { active: Active }) {
  const toast = useStore((s) => s.toast);
  const liveAdb = useStore((s) => s.liveAdb);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<logcat.LogLine[]>([]);
  const [minLevel, setMinLevel] = useState<logcat.LogLevel>("V");
  const [pkg, setPkg] = useState("");
  const [packages, setPackages] = useState<{ thirdParty: string[]; system: string[] }>({
    thirdParty: [],
    system: [],
  });
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const sessionRef = useRef<logcat.LogcatSession | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // System and preinstalled packages belong here too — on these devices the
  // interesting logs often come from a preinstalled app, and leaving them out
  // meant the process filter simply couldn't be pointed at them. They stay in a
  // separate group, below the third-party ones, because that list is 200+ entries
  // and is not what most people are looking for.
  useEffect(() => {
    let alive = true;
    void Promise.all([
      apps.appList(active.adb, "thirdParty").catch(() => [] as string[]),
      apps.appList(active.adb, "system").catch(() => [] as string[]),
    ])
      .then(([thirdParty, system]) => alive && setPackages({ thirdParty, system }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active.adb]);

  const stop = useCallback(async () => {
    const s = sessionRef.current;
    sessionRef.current = null;
    setRunning(false);
    if (s) await s.stop();
  }, []);

  // Always tear the stream down when leaving or switching devices, or logcat keeps
  // running and holding an adb socket.
  useEffect(() => {
    return () => {
      const s = sessionRef.current;
      sessionRef.current = null;
      if (s) void s.stop();
    };
  }, [active.adb]);

  async function start(clearFirst: boolean) {
    await stop();
    if (clearFirst) setLines([]);
    try {
      // Same reason as 投屏: a stream started on a transport left over from before
      // a replug fails with an id number instead of starting. See Mirror.start.
      const adb = await liveAdb("日志");
      const session = await logcat.startLogcat(
        adb,
        { packageName: pkg || undefined, minLevel, clearFirst },
        (batch) =>
          setLines((prev) => {
            const next = prev.concat(batch);
            // Drop from the front once over budget — unbounded growth would
            // eventually stall the tab.
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          }),
        (reason) => {
          setRunning(false);
          sessionRef.current = null;
          toast("info", `日志已停止：${reason}`);
        }
      );
      sessionRef.current = session;
      setRunning(true);
    } catch (e) {
      toast("error", errorMessage(e));
    }
  }

  const shown = lines.filter((l) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return l.message.toLowerCase().includes(q) || l.tag.toLowerCase().includes(q);
  });
  const tail = shown.slice(Math.max(0, shown.length - RENDER_LIMIT));

  // Stick to the bottom while following.
  useEffect(() => {
    if (!follow) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail.length, follow]);

  function exportLog() {
    const text = shown
      .map((l) => `${l.time} ${l.pid} ${l.tid} ${l.level} ${l.tag}: ${l.message}`)
      .join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `logcat-${active.device.serial}-${Date.now()}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="row" style={{ marginBottom: 14 }}>
        {running ? (
          <button className="btn danger" onClick={() => void stop()}>
            <Icon name="stop" />
            停止
          </button>
        ) : (
          <button className="btn primary" onClick={() => void start(false)}>
            <Icon name="play" />
            开始
          </button>
        )}
        <button className="btn ghost" onClick={() => void start(true)} title="清空设备缓冲并重新开始">
          <Icon name="refresh" />
          清空重开
        </button>

        <select value={pkg} onChange={(e) => setPkg(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">全部进程</option>
          {packages.thirdParty.length > 0 && (
            <optgroup label="第三方应用">
              {packages.thirdParty.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </optgroup>
          )}
          {packages.system.length > 0 && (
            <optgroup label="系统 / 预装应用">
              {packages.system.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </optgroup>
          )}
        </select>

        <select
          value={minLevel}
          onChange={(e) => setMinLevel(e.target.value as logcat.LogLevel)}
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {LEVEL_LABEL[l]}
            </option>
          ))}
        </select>

        <input
          type="search"
          placeholder="过滤 tag / 内容"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 140 }}
        />

        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          跟随
        </label>
        <button className="btn ghost sm" onClick={() => setLines([])} title="清空视图">
          <Icon name="trash" />
        </button>
        <button className="btn ghost sm" onClick={exportLog} disabled={!shown.length} title="导出">
          <Icon name="download" />
        </button>
      </div>

      {(pkg || minLevel !== "V") && (
        <p className="muted" style={{ fontSize: 12, margin: "0 0 10px" }}>
          进程与级别过滤由 logcat 在设备端执行，改动后需重新开始才生效。
        </p>
      )}

      <div className="logbody" ref={bodyRef}>
        {tail.length === 0 ? (
          <div className="muted" style={{ padding: 24, textAlign: "center" }}>
            {running ? "等待日志…" : "点“开始”读取设备日志"}
          </div>
        ) : (
          tail.map((l) => (
            <div key={l.id} className={`logline lv-${l.level}`}>
              <span className="t">{l.time.slice(6)}</span>
              <span className="lv">{l.level}</span>
              <span className="tg" title={l.tag}>
                {l.tag}
              </span>
              <span className="msg">{l.message}</span>
            </div>
          ))
        )}
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        {shown.length} 行
        {shown.length !== lines.length && ` / 共 ${lines.length}`}
        {shown.length > RENDER_LIMIT && ` · 显示最后 ${RENDER_LIMIT} 行`}
        {lines.length >= MAX_LINES && " · 已达缓冲上限，最旧的会被丢弃"}
      </div>
    </div>
  );
}
