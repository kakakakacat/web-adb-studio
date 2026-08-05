// Live network capture.
//
// Data comes from the app's own collector over an abstract LocalSocket (see
// ../adb/capture.ts), so unlike a proxy this shows what the app actually sent and
// received — after TLS, before compression, with gRPC method and status intact.
//
// Two things shape the layout: the list has to stay readable while hundreds of
// rows/second land in it (so: fixed columns, tail rendering, no cards), and the
// detail pane has to serve four different body shapes (JSON, protobuf, text,
// binary) without guessing wrong being expensive.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as capture from "../adb/capture";
import { hexDump, printableText, scan, type ProtoField } from "../adb/protoscan";
import type { TypeIndex } from "../adb/protodesc";
import { useStore, type Active } from "../store";
import { errorMessage } from "../types";
import { Icon } from "./Icon";

/** Ring buffer. Calls are much heavier than log lines, so this is smaller. */
const MAX_CALLS = 2000;
const RENDER_LIMIT = 400;

type Filter = "all" | "http" | "grpc" | "ws";

/** 和设备侧 CaptureServer.DESCRIPTORS_REF 对齐。 */
const DESCRIPTORS_REF = "descriptors";

/** One request/call, assembled from the several events the device sends for it. */
interface Call {
  id: string;
  kind: capture.Kind;
  t: number;
  mono: number;
  thread: string;
  /** HTTP: method; gRPC: call type; WS: "WS". */
  verb: string;
  /** HTTP: host; gRPC: authority; WS: host. */
  host: string;
  /** HTTP: path; gRPC: full method; WS: path. */
  name: string;
  status?: string;
  ok?: boolean;
  durMs?: number;
  reqLen?: number;
  respLen?: number;
  done: boolean;
  error?: string;
  /** Every event as received, for the timeline and the detail pane. */
  events: capture.CaptureEvent[];
  /** Streaming messages (gRPC / WS), in arrival order. */
  messages: capture.CaptureEvent[];
}

export function Net({ active }: { active: Active }) {
  const toast = useStore((s) => s.toast);
  const liveAdb = useStore((s) => s.liveAdb);
  const [running, setRunning] = useState(false);
  const [hello, setHello] = useState<capture.Hello | null>(null);
  // 采集器只能从"设备上正在监听的"里选，不给手输 —— 名字是 netcapture.<包名>，
  // 手输等于让人背包名，而且拼错了只会得到一个连不上的报错。
  const [socketName, setSocketName] = useState("");
  const [sockets, setSockets] = useState<string[]>([]);
  const [scanning, setScanning] = useState(true);
  const [calls, setCalls] = useState<Call[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  // 选中和打开是两件事：单击只选中（高亮），再点同一条才展开详情。列表刷得很快，
  // 单击即展开会让人误开一条正在滚走的请求。
  const [selected, setSelected] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  /** descriptor set 解析出的类型索引；没有它就退回按字段号显示。 */
  const [index, setIndex] = useState<TypeIndex | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const [follow, setFollow] = useState(true);

  const sessionRef = useRef<capture.CaptureSession | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Bodies live outside React state: they're large and never re-rendered wholesale. */
  const blobs = useRef(new Map<string, capture.Blob>());

  // Which apps have a collector listening. Also the answer to "why is there
  // nothing here" — an empty list means no debug build with capture is running.
  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const names = await capture.listSockets(active.adb);
      setSockets(names);
      // 保留当前选择（如果还在），否则选第一个。
      setSocketName((current) => (names.includes(current) ? current : (names[0] ?? "")));
    } catch {
      setSockets([]);
    } finally {
      setScanning(false);
    }
  }, [active.adb]);

  useEffect(() => {
    void scan();
  }, [scan]);

  const stop = useCallback(async () => {
    const s = sessionRef.current;
    sessionRef.current = null;
    setRunning(false);
    if (s) await s.close();
  }, []);

  // Leaving the tab or swapping devices must close the socket: that is what tells
  // the device nobody is subscribed, which is what returns the app to zero cost.
  useEffect(() => {
    return () => {
      const s = sessionRef.current;
      sessionRef.current = null;
      if (s) void s.close();
    };
  }, [active.adb]);

  async function start() {
    await stop();
    try {
      const adb = await liveAdb("抓包");
      const session = await capture.startCapture(adb, socketName, {
        onBatch: (events) => setCalls((prev) => merge(prev, events, setDropped)),
        onBlob: (blob) => {
          // 设备在握手后紧跟着推一份 descriptor set。protobufjs 只在真的需要时才加载，
          // 所以这里用动态 import，不进主 bundle。
          if (blob.ref === DESCRIPTORS_REF) {
            void import("../adb/protodesc")
              .then((m) => setIndex(m.TypeIndex.load(blob.bytes)))
              .catch((e) => setIndexError(errorMessage(e)));
            return;
          }
          blobs.current.set(blob.ref, blob);
        },
        onEnd: (reason) => {
          setRunning(false);
          sessionRef.current = null;
          toast("info", `抓包已停止：${reason}`);
        },
      });
      sessionRef.current = session;
      setHello(session.hello);
      setRunning(true);
      toast("success", `已连上 ${session.hello.pkg}（pid ${session.hello.pid}）`);
    } catch (e) {
      toast("error", errorMessage(e));
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return calls.filter((c) => {
      if (filter !== "all" && c.kind !== filter) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.host.toLowerCase().includes(q) ||
        (c.status ?? "").toLowerCase().includes(q)
      );
    });
  }, [calls, filter, query]);

  const tail = shown.slice(Math.max(0, shown.length - RENDER_LIMIT));
  const current = opened ? calls.find((c) => c.id === opened) : undefined;

  useEffect(() => {
    // 选中一条就停止自动滚动，否则刚点中的那条会被新来的请求推走。
    if (!follow || selected) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail.length, follow, current]);

  function clear() {
    setCalls([]);
    setSelected(null);
    setOpened(null);
    blobs.current.clear();
    setDropped(0);
  }

  function exportJson() {
    const data = shown.map((c) => ({
      ...c,
      bodies: bodyRefsOf(c)
        .map((ref) => {
          const b = blobs.current.get(ref);
          if (!b) return null;
          return { ref, truncatedFrom: b.truncatedFrom, text: safeText(b.bytes) };
        })
        .filter(Boolean),
    }));
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `netcapture-${active.device.serial}-${data.length}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="row" style={{ marginBottom: 12 }}>
        {running ? (
          <button className="btn danger" onClick={() => void stop()}>
            <Icon name="stop" />
            停止
          </button>
        ) : (
          <button
            className="btn primary"
            onClick={() => void start()}
            disabled={!socketName}
            title={socketName ? "" : "没有可抓包的应用：先启动一个带 SDK 的 debug 包"}
          >
            <Icon name="play" />
            开始
          </button>
        )}

        <select
          className="netsocket"
          value={socketName}
          onChange={(e) => setSocketName(e.target.value)}
          disabled={running || sockets.length === 0}
          title="设备上正在监听的采集器，按应用列出"
          style={{ maxWidth: 260 }}
        >
          {sockets.length === 0 ? (
            <option value="">
              {scanning ? "正在扫描设备…" : "没有可抓包的应用"}
            </option>
          ) : (
            // 显示包名而不是 socket 名 —— 用户要选的是"哪个应用"。
            sockets.map((s) => (
              <option key={s} value={s}>
                {capture.packageOf(s)}
              </option>
            ))
          )}
        </select>
        <button
          className="btn ghost sm"
          onClick={() => void scan()}
          disabled={running || scanning}
          title="重新扫描（刚启动的应用需要点一下）"
        >
          <Icon name="refresh" />
        </button>

        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">全部协议</option>
          <option value="http">HTTP</option>
          <option value="grpc">gRPC</option>
          <option value="ws">WebSocket</option>
        </select>

        <input
          type="search"
          placeholder="过滤 host / path / method / 状态"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 140 }}
        />

        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          跟随
        </label>
        <button className="btn ghost sm" onClick={clear} title="清空">
          <Icon name="trash" />
        </button>
        <button className="btn ghost sm" onClick={exportJson} disabled={!shown.length} title="导出 JSON">
          <Icon name="download" />
        </button>
      </div>

      {!running && calls.length === 0 && (
        <p className="muted" style={{ fontSize: 12, margin: "0 0 10px" }}>
          {sockets.length === 0 && !scanning
            ? "设备上没有正在监听的采集器。先启动一个带抓包 SDK 的 debug 包，再点右边的刷新。"
            : "数据来自应用进程内的采集器，只有 debug / internal 包才有。没连上时应用侧不做任何采集，所以要先让目标应用跑起来，再点开始。"}
        </p>
      )}

      {hello && running && (
        <p className="muted" style={{ fontSize: 12, margin: "0 0 10px" }}>
          {hello.pkg} · {hello.process} · pid {hello.pid} / uid {hello.uid} ·
          {" "}body 上限 {Math.round(hello.maxTextBody / 1024)}K 文本 /
          {" "}{Math.round(hello.maxBinaryBody / 1024)}K 二进制
          {dropped > 0 && ` · 设备端已丢弃 ${dropped} 条（队列满）`}
          {index
            ? ` · descriptor 已加载（${index.serviceCount} 服务 / ${index.methodCount} 方法），protobuf 显示字段名`
            : indexError
              ? ` · descriptor 解析失败：${indexError}`
              : " · 无 descriptor，protobuf 按字段号显示"}
        </p>
      )}

      <div className="netsplit">
        <div className="netlist" ref={bodyRef}>
          {/* 表头。列的含义按协议不同（主机=host/authority，路径=path/gRPC 方法），
              所以标签取中性说法；粘在顶部，滚动时不丢。 */}
          <div className="nethead">
            <span>时间</span>
            <span>协议</span>
            <span>方法</span>
            <span>主机</span>
            <span>路径 / gRPC 方法</span>
            <span>状态</span>
            <span className="r">耗时</span>
            <span className="r">大小</span>
          </div>
          {tail.length === 0 ? (
            <div className="muted" style={{ padding: 24, textAlign: "center" }}>
              {running ? "等待请求…" : "点“开始”连接设备上的采集器"}
            </div>
          ) : (
            tail.map((c) => (
              <button
                key={c.id}
                className={`netrow ${selected === c.id ? "sel" : ""} ${
                  opened === c.id ? "on" : ""
                } ${statusClass(c)}`}
                onClick={() => {
                  if (selected !== c.id) {
                    // 第一下只选中，并且把可能开着的详情收起来
                    setSelected(c.id);
                    setOpened(null);
                  } else {
                    // 第二下点在同一条上：展开／收起详情
                    setOpened((o) => (o === c.id ? null : c.id));
                  }
                }}
              >
                <span className="t">{clock(c.t)}</span>
                <span className={`k k-${c.kind}`}>{c.kind}</span>
                <span className="verb">{c.verb}</span>
                <span className="host" title={c.host}>
                  {c.host}
                </span>
                <span className="name" title={c.name}>
                  {c.name}
                </span>
                <span className="st">{c.done ? (c.status ?? "—") : "···"}</span>
                <span className="dur">{c.durMs !== undefined ? `${c.durMs}ms` : ""}</span>
                <span className="sz">{size(c.respLen ?? c.reqLen)}</span>
              </button>
            ))
          )}
        </div>

        {current && (
          <Detail
            call={current}
            blobs={blobs.current}
            index={index}
            onClose={() => setOpened(null)}
          />
        )}
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        {shown.length} 条{shown.length !== calls.length && ` / 共 ${calls.length}`}
        {shown.length > RENDER_LIMIT && ` · 显示最后 ${RENDER_LIMIT} 条`}
        {calls.length >= MAX_CALLS && " · 已达缓冲上限，最旧的会被丢弃"}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- detail pane */

type BodyTab = "pretty" | "raw" | "hex";

function Detail({
  call,
  blobs,
  index,
  onClose,
}: {
  call: Call;
  blobs: Map<string, capture.Blob>;
  index: TypeIndex | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<BodyTab>("pretty");
  // 从 gRPC 方法名精确定位请求/响应类型，而不是从载荷去猜。
  const grpcTypes = call.kind === "grpc" ? index?.methodTypes(call.name) : undefined;
  const start = call.events.find((e) => e.phase === "start");
  const end = call.events.find((e) => e.phase === "end");
  const headers = call.events.find((e) => e.phase === "headers");

  return (
    <div className="netdetail">
      <div className="row" style={{ marginBottom: 10 }}>
        <strong style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
          {call.verb} {call.name}
        </strong>
        {(["pretty", "raw", "hex"] as BodyTab[]).map((t) => (
          <button
            key={t}
            className={`btn sm ${tab === t ? "" : "ghost"}`}
            onClick={() => setTab(t)}
          >
            {t === "pretty" ? "格式化" : t === "raw" ? "原文" : "Hex"}
          </button>
        ))}
        <button className="btn ghost sm" onClick={onClose} title="关闭详情">
          ×
        </button>
      </div>

      <div className="netdetail-body">
        <Section title="概览">
          <Kv k="协议" v={call.kind} />
          {start?.url !== undefined && <Kv k="URL" v={String(start.url)} />}
          {call.kind === "grpc" && <Kv k="Method" v={call.name} />}
          <Kv k="Host" v={call.host} />
          {call.status !== undefined && <Kv k="状态" v={call.status} />}
          {end?.protocol !== undefined && <Kv k="传输" v={String(end.protocol)} />}
          {call.durMs !== undefined && <Kv k="耗时" v={`${call.durMs} ms`} />}
          <Kv k="线程" v={call.thread} />
          {end?.redirects ? <Kv k="重定向" v={`${end.redirects} 次`} /> : null}
          {end?.fromCache ? <Kv k="缓存" v="命中 OkHttp 缓存" /> : null}
          {end?.tls !== undefined && (
            <Kv
              k="TLS"
              v={`${(end.tls as Record<string, string>).version} · ${
                (end.tls as Record<string, string>).cipher
              }`}
            />
          )}
          {call.error && <Kv k="错误" v={call.error} />}
        </Section>

        {objectOf(start?.reqHeaders) && (
          <Section title="请求 Header">
            <HeaderTable headers={objectOf(start?.reqHeaders)!} />
          </Section>
        )}
        {objectOf(start?.metadata) && (
          <Section title="请求 Metadata">
            <HeaderTable headers={objectOf(start?.metadata)!} />
          </Section>
        )}

        {/* A GET has no request body; an empty "没有采到" block there is noise, not
            information. Only claim something is missing when something could have
            been there. */}
        {call.kind !== "grpc" && (numberOf(start?.reqLen) ?? 0) > 0 && (
          <BodyView title="请求体" blob={blobs.get(`${call.id}:req`)} tab={tab} index={index} />
        )}

        {objectOf(end?.respHeaders) && (
          <Section title="响应 Header">
            <HeaderTable headers={objectOf(end?.respHeaders)!} />
          </Section>
        )}
        {objectOf(headers?.metadata) && (
          <Section title="响应 Metadata">
            <HeaderTable headers={objectOf(headers?.metadata)!} />
          </Section>
        )}

        {call.kind !== "grpc" && (
          <BodyView title="响应体" blob={blobs.get(`${call.id}:resp`)} tab={tab} index={index} />
        )}

        {call.messages.length > 0 && (
          <Section title={`流式消息 · ${call.messages.length} 条`}>
            {call.messages.map((m, i) => (
              <div key={i} className="netmsg">
                <div className="netmsg-head">
                  <span className={`k k-${m.dir === "up" ? "grpc" : "http"}`}>
                    {m.dir === "up" ? "↑ 上行" : "↓ 下行"}
                  </span>
                  <span className="muted">
                    #{String(m.seq)} · {size(Number(m.len))}
                    {m.type ? ` · ${String(m.type).split(".").pop()}` : ""}
                  </span>
                </div>
                <BodyView
                  title=""
                  blob={blobs.get(`${call.id}:${m.dir}${m.seq}`)}
                  tab={tab}
                  compact
                  index={index}
                  typeName={
                    (m.dir === "up" ? grpcTypes?.input : grpcTypes?.output) ??
                    index?.fromJavaClass(typeof m.type === "string" ? m.type : undefined)
                  }
                />
              </div>
            ))}
          </Section>
        )}

        {objectOf(end?.trailers) && (
          <Section title="Trailers">
            <HeaderTable headers={objectOf(end?.trailers)!} />
          </Section>
        )}

        <Section title="时间线">
          {call.events.map((e, i) => (
            <div key={i} className="netline">
              <span className="muted">+{e.mono - call.mono}ms</span>
              <span>{e.phase}</span>
              <span className="muted">{e.thread}</span>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}

function BodyView({
  title,
  blob,
  tab,
  compact,
  index,
  typeName,
}: {
  title: string;
  blob?: capture.Blob;
  tab: BodyTab;
  compact?: boolean;
  index: TypeIndex | null;
  /** protobuf 全限定类型名；有它才能显示字段名。 */
  typeName?: string;
}) {
  if (!blob) {
    if (compact || !title) return null;
    return (
      <Section title={title}>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          没有采到 —— 空 body，或者是 SSE / 音视频 / 超过上限，这些按策略只记元数据。
        </p>
      </Section>
    );
  }

  const content = render(blob, tab, index, typeName);
  const inner = (
    <>
      {blob.truncatedFrom > 0 && (
        <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
          已截断：设备端原始长度 {size(blob.truncatedFrom)}，只传了 {size(blob.bytes.length)}
        </p>
      )}
      <pre className="netpre">{content}</pre>
    </>
  );
  return compact || !title ? inner : <Section title={title}>{inner}</Section>;
}

function render(
  blob: capture.Blob,
  tab: BodyTab,
  index: TypeIndex | null,
  typeName?: string
): string {
  if (tab === "hex") return hexDump(blob.bytes);
  if (tab === "raw") return safeText(blob.bytes) ?? hexDump(blob.bytes);

  // 类型已知就按 descriptor 解 —— 这是唯一能给出字段名的路径，优先于任何启发式。
  // 截断过的 body 解不出来是正常的（少了后半截），所以失败就静默回落。
  if (index && typeName) {
    const decoded = index.decode(typeName, blob.bytes);
    if (decoded !== undefined) {
      return `// ${typeName.replace(/^\./, "")}\n${JSON.stringify(decoded, null, 2)}`;
    }
  }

  // Order matters. Decoding as UTF-8 first was wrong: a small protobuf is often
  // *valid* UTF-8, so it rendered as a line of text with invisible control
  // characters instead of a field tree. Only genuinely printable text is treated
  // as text; everything else gets the protobuf reading first.
  const text = printableText(blob.bytes);
  if (text !== undefined) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        /* not JSON after all */
      }
    }
    return text;
  }
  const parsed = scan(blob.bytes);
  if (parsed.ok) return renderProto(parsed.fields, 0);
  return safeText(blob.bytes) ?? hexDump(blob.bytes);
}

function renderProto(fields: ProtoField[], depth: number): string {
  const pad = "  ".repeat(depth);
  return fields
    .map((f) => {
      const head = `${pad}${f.field}: ${f.value}`;
      return f.nested ? `${head}\n${renderProto(f.nested, depth + 1)}` : head;
    })
    .join("\n");
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="netsection">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="netline">
      <span className="muted" style={{ minWidth: 62 }}>
        {k}
      </span>
      <span className="mono" style={{ wordBreak: "break-all" }}>
        {v}
      </span>
    </div>
  );
}

function HeaderTable({ headers }: { headers: Record<string, unknown> }) {
  return (
    <div>
      {Object.entries(headers).map(([k, v]) => (
        <div key={k} className="netline">
          <span className="muted" style={{ minWidth: 62 }}>
            {k}
          </span>
          <span className="mono" style={{ wordBreak: "break-all" }}>
            {String(v)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------- model */

/**
 * Fold events into calls.
 *
 * The device emits several events per call (start / headers / message… / end) and
 * they can arrive after the row is already on screen, so this is an upsert keyed by
 * the device-assigned id rather than an append.
 */
function merge(
  prev: Call[],
  events: capture.CaptureEvent[],
  setDropped: (n: number) => void
): Call[] {
  const next = prev.slice();
  const index = new Map(next.map((c, i) => [c.id, i]));

  for (const e of events) {
    if (typeof e.dropped === "number") setDropped(e.dropped);

    const at = index.get(e.id);
    if (at === undefined) {
      const call = seed(e);
      index.set(e.id, next.length);
      next.push(call);
      apply(call, e);
      continue;
    }
    // Copy on write: the row has to be a new object for React to notice.
    const call = { ...next[at], events: next[at].events.slice(), messages: next[at].messages.slice() };
    apply(call, e);
    next[at] = call;
  }

  return next.length > MAX_CALLS ? next.slice(next.length - MAX_CALLS) : next;
}

function seed(e: capture.CaptureEvent): Call {
  return {
    id: e.id,
    kind: e.kind,
    t: e.t,
    mono: e.mono,
    thread: e.thread,
    verb: e.kind === "ws" ? "WS" : "",
    host: "",
    name: "",
    done: false,
    events: [],
    messages: [],
  };
}

function apply(call: Call, e: capture.CaptureEvent) {
  call.events.push(e);

  if (e.phase === "start") {
    if (e.kind === "http") {
      call.verb = String(e.method ?? "");
      call.host = String(e.host ?? "");
      call.name = String(e.path ?? "") + (e.query ? `?${String(e.query)}` : "");
      call.reqLen = numberOf(e.reqLen);
    } else if (e.kind === "grpc") {
      call.verb = shortCallType(String(e.callType ?? ""));
      call.host = String(e.authority ?? "");
      call.name = String(e.method ?? "");
    } else {
      const url = String(e.url ?? "");
      call.verb = "WS";
      try {
        const u = new URL(url);
        call.host = u.host;
        call.name = u.pathname;
      } catch {
        call.name = url;
      }
    }
    return;
  }

  if (e.phase === "message") {
    call.messages.push(e);
    return;
  }

  if (e.phase === "end") {
    call.done = true;
    call.durMs = numberOf(e.durMs);
    if (e.kind === "http") {
      call.status = String(e.status ?? "");
      call.ok = numberOf(e.status) !== undefined && numberOf(e.status)! < 400;
      call.respLen = numberOf(e.respLen);
    } else if (e.kind === "grpc") {
      call.status = String(e.code ?? "");
      call.ok = e.code === "OK";
    } else {
      call.status = String(e.code ?? "");
      call.ok = true;
    }
    return;
  }

  if (e.phase === "error") {
    call.done = true;
    call.ok = false;
    call.status = "ERR";
    call.error = String(e.error ?? "");
    call.durMs = numberOf(e.durMs) ?? call.durMs;
  }
}

/* ----------------------------------------------------------------- utilities */

function bodyRefsOf(call: Call): string[] {
  const refs = [`${call.id}:req`, `${call.id}:resp`];
  for (const m of call.messages) refs.push(`${call.id}:${m.dir}${m.seq}`);
  return refs;
}

/** Undefined for anything that isn't a non-empty object, so empty header and
 *  metadata blocks don't render as a bare heading with nothing under it. */
function objectOf(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  return Object.keys(o).length > 0 ? o : undefined;
}

function numberOf(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function safeText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function shortCallType(t: string): string {
  switch (t) {
    case "UNARY":
      return "unary";
    case "CLIENT_STREAMING":
      return "→流";
    case "SERVER_STREAMING":
      return "流→";
    case "BIDI_STREAMING":
      return "双向";
    default:
      return t.toLowerCase();
  }
}

function statusClass(c: Call): string {
  if (!c.done) return "pending";
  if (c.ok === false) return "bad";
  return "";
}

function clock(t: number): string {
  const d = new Date(t);
  return (
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:` +
    `${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`
  );
}

function size(n?: number): string {
  if (n === undefined || n < 0) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
