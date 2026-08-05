// Performance panel for one app: CPU, memory, and how many frames miss their
// deadline. Lives inside the app detail because it only makes sense for a chosen
// package.
//
// The sparkline is hand-drawn SVG rather than a chart library — three series of
// ~60 points doesn't justify adding a dependency to a bundle that already carries
// a full ADB implementation.

import { useCallback, useEffect, useRef, useState } from "react";

import * as perf from "../adb/perf";
import { useStore, type Active } from "../store";
import { errorMessage } from "../types";
import { Icon } from "./Icon";

const INTERVAL_MS = 2000;
/** ~2 minutes of history at the sample interval. */
const MAX_POINTS = 60;

function Spark({
  values,
  max,
  color,
}: {
  values: number[];
  max: number;
  color: string;
}) {
  if (values.length < 2) {
    return <div className="spark-empty">采样中…</div>;
  }
  const w = 100;
  const h = 30;
  const ceiling = Math.max(max, ...values) || 1;
  const step = w / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(2)},${(h - (v / ceiling) * h).toFixed(2)}`)
    .join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline
        points={`0,${h} ${points} ${w},${h}`}
        fill={color}
        fillOpacity="0.13"
        stroke="none"
      />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Metric({
  label,
  value,
  unit,
  values,
  max,
  color,
}: {
  label: string;
  value?: number;
  unit: string;
  values: number[];
  max: number;
  color: string;
}) {
  return (
    <div className="stat">
      <div className="k">{label}</div>
      <div className="v">
        {value === undefined ? "—" : `${value.toFixed(value < 10 ? 1 : 0)}${unit}`}
      </div>
      <Spark values={values} max={max} color={color} />
    </div>
  );
}

export function Perf({ active, pkg }: { active: Active; pkg: string }) {
  const toast = useStore((s) => s.toast);
  const [samples, setSamples] = useState<perf.Sample[]>([]);
  const [running, setRunning] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const runningRef = useRef(false);
  const lastRef = useRef<perf.Sample | undefined>(undefined);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  // Sampling holds the adb connection busy; never let it outlive the view or the
  // selected package.
  useEffect(() => {
    stop();
    setSamples([]);
    lastRef.current = undefined;
    return stop;
  }, [pkg, active.adb, stop]);

  const tick = useCallback(async () => {
    if (!runningRef.current) return;
    try {
      const s = await perf.sample(active.adb, pkg, lastRef.current);
      if (!runningRef.current) return;
      lastRef.current = s;
      setSamples((prev) => {
        const next = prev.concat(s);
        return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
      });
    } catch (e) {
      // Most often "not running" — stop rather than spam the same error every 2s.
      stop();
      toast("error", errorMessage(e));
      return;
    }
    if (runningRef.current) timer.current = setTimeout(() => void tick(), INTERVAL_MS);
  }, [active.adb, pkg, stop, toast]);

  async function start() {
    // Clear the cumulative counters so the first jank figure covers our window.
    await perf.resetFrameStats(active.adb, pkg).catch(() => {});
    lastRef.current = undefined;
    setSamples([]);
    runningRef.current = true;
    setRunning(true);
    void tick();
  }

  const latest = samples.at(-1);
  const cpuSeries = samples.map((s) => s.cpu ?? 0);
  const memSeries = samples.map((s) => s.memoryMb ?? 0);
  const jankSeries = samples.map((s) => s.jankPercent ?? 0);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <span className="k" style={{ fontSize: 11, letterSpacing: "0.09em", color: "var(--text-3)" }}>
          性能
        </span>
        {running ? (
          <button className="btn sm danger" onClick={stop}>
            <Icon name="stop" />
            停止
          </button>
        ) : (
          <button className="btn sm" onClick={() => void start()}>
            <Icon name="play" />
            开始采样
          </button>
        )}
      </div>

      {samples.length === 0 && !running ? (
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          每 {INTERVAL_MS / 1000} 秒采样一次 CPU、内存和掉帧率。需要应用正在运行；掉帧只在应用位于前台渲染时才有数据。
        </p>
      ) : (
        <div className="stats" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
          <Metric
            label="CPU"
            value={latest?.cpu}
            unit="%"
            values={cpuSeries}
            max={100}
            color="var(--accent)"
          />
          <Metric
            label="内存 PSS"
            value={latest?.memoryMb}
            unit=" MB"
            values={memSeries}
            max={256}
            color="#6aa9ff"
          />
          <Metric
            label="掉帧"
            value={latest?.jankPercent}
            unit="%"
            values={jankSeries}
            max={20}
            color="var(--warn)"
          />
        </div>
      )}

      {latest?.frames !== undefined && (
        <p className="muted" style={{ fontSize: 11.5, margin: "10px 0 0" }}>
          累计 {latest.frames} 帧，其中 {latest.jankyFrames ?? 0} 帧超时
          {latest.jankPercent !== undefined && ` · 本次区间掉帧 ${latest.jankPercent.toFixed(1)}%`}
        </p>
      )}
    </>
  );
}
