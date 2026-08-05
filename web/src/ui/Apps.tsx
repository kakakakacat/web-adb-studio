import { useCallback, useEffect, useRef, useState } from "react";

import * as apps from "../adb/apps";
import { useStore, type Active } from "../store";
import { errorMessage, type AppListFilter, type InstalledApp } from "../types";
import { Icon, Tile } from "./Icon";
import { Perf } from "./Perf";

const FILTERS: { key: AppListFilter; label: string }[] = [
  { key: "thirdParty", label: "第三方" },
  { key: "all", label: "全部" },
  { key: "system", label: "系统" },
  { key: "disabled", label: "已禁用" },
];

/**
 * Colleagues get a DM tab where everyone else gets 第三方.
 *
 * On a company device the apps worth looking at are preinstalled, so `pm list -3`
 * lists everything *except* them — the useful cut is by package prefix. Outside
 * visitors have no DeepMirror packages to list, so they keep the ordinary one.
 */
function filtersFor(privileged: boolean): { key: AppListFilter; label: string }[] {
  if (!privileged) return FILTERS;
  return FILTERS.map((f) => (f.key === "thirdParty" ? { key: "dm", label: "DM" } : f));
}

/** Last path segment of a package name — a readable label at card size. */
function shortName(pkg: string): string {
  const parts = pkg.split(".");
  return parts.length > 1 ? parts.slice(-1)[0] : pkg;
}

export function Apps({ active }: { active: Active }) {
  const toast = useStore((s) => s.toast);
  const privileged = useStore((s) => s.health?.privileged ?? false);
  const filters = filtersFor(privileged);
  // Default to the first tab of whichever set applies, so a colleague lands on
  // DM rather than on a 第三方 tab that is no longer shown.
  const [filter, setFilter] = useState<AppListFilter>(privileged ? "dm" : "thirdParty");

  // `privileged` arrives with the health response, after the first render. Without
  // this the tab bar would swap to DM while the selection stayed on a 第三方 tab
  // that is no longer displayed — nothing highlighted, and the wrong list shown.
  useEffect(() => {
    if (privileged && filter === "thirdParty") setFilter("dm");
    if (!privileged && filter === "dm") setFilter("thirdParty");
  }, [privileged, filter]);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<string[] | null>(null);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<InstalledApp | null>(null);
  const [working, setWorking] = useState(false);
  const [diag, setDiag] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    setList(null);
    setSelected(null);
    setDetail(null);
    try {
      setList(await apps.appList(active.adb, filter));
    } catch (e) {
      setList([]);
      toast("error", errorMessage(e));
    }
  }, [active.adb, filter, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = (list ?? []).filter((p) =>
    query ? p.toLowerCase().includes(query.toLowerCase()) : true
  );

  // Icons cost one adb round-trip each, so they load on demand as cards scroll
  // into view. A fixed cap ("first N packages") was the wrong shape: the system
  // filter has 200+ packages, and everything past the cap stayed a grey square
  // forever, which reads as broken rather than as not-loaded-yet.
  const requested = useRef(new Set<string>());
  const gridRef = useRef<HTMLDivElement>(null);
  const shownKey = shown.join(",");

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || shown.length === 0) return;

    let alive = true;
    const queue: string[] = [];
    let inFlight = 0;
    const CONCURRENCY = 4;

    const pump = () => {
      while (alive && inFlight < CONCURRENCY && queue.length > 0) {
        const pkg = queue.shift()!;
        inFlight += 1;
        void apps
          .appIcon(active.adb, pkg)
          .catch(() => null)
          .then((icon) => {
            if (alive) setIcons((prev) => ({ ...prev, [pkg]: icon }));
          })
          .finally(() => {
            inFlight -= 1;
            if (alive) pump();
          });
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const pkg = (entry.target as HTMLElement).dataset.pkg;
          if (pkg && !requested.current.has(pkg)) {
            requested.current.add(pkg);
            queue.push(pkg);
          }
          io.unobserve(entry.target); // one request per package
        }
        pump();
      },
      // Start slightly before a card is visible so scrolling doesn't reveal blanks.
      { root: grid, rootMargin: "300px" }
    );

    for (const el of grid.querySelectorAll<HTMLElement>(".app-card")) io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [shownKey, shown.length, active.adb]);

  useEffect(() => {
    setIcons({});
    requested.current = new Set();
  }, [active.adb]);

  // A package with genuinely no icon resolves to null too, so require a clear
  // majority before implying something is wrong.
  const resolved = Object.values(icons);
  const iconTrouble =
    resolved.length >= 3 && resolved.filter((i) => i === null).length / resolved.length > 0.5;

  async function open(pkg: string) {
    setSelected(pkg);
    setDetail(null);
    try {
      setDetail(await apps.appInfo(active.adb, pkg));
    } catch (e) {
      toast("error", errorMessage(e));
    }
  }

  async function act(label: string, fn: () => Promise<void>, reload = false) {
    setWorking(true);
    try {
      await fn();
      toast("success", `${label}成功`);
      if (reload) await load();
      else if (selected) await open(selected);
    } catch (e) {
      toast("error", `${label}失败：${errorMessage(e)}`);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.6fr) minmax(300px, 1fr)" }}>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
          <div className="tabs">
            {filters.map((f) => (
              <button
                key={f.key}
                className={`tab ${filter === f.key ? "on" : ""}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="row">
            <input
              type="search"
              placeholder="搜索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: 180 }}
            />
            <button className="btn sm ghost" onClick={() => void load()} title="刷新">
              <Icon name="refresh" />
            </button>
          </div>
        </div>

        {list === null ? (
          <div className="muted" style={{ padding: 30, textAlign: "center" }}>
            读取中…
          </div>
        ) : shown.length === 0 ? (
          <div className="muted" style={{ padding: 30, textAlign: "center" }}>
            没有匹配的应用
          </div>
        ) : (
          <div className="app-grid" ref={gridRef}>
            {shown.map((pkg) => (
              <button
                key={pkg}
                data-pkg={pkg}
                className={`app-card ${selected === pkg ? "on" : ""}`}
                onClick={() => void open(pkg)}
                title={pkg}
              >
                {/* Three states, and they must look different: not fetched yet
                    (blank placeholder), fetched but the package has no icon at
                    all (generic glyph), and fetched (the icon). Most system
                    packages are providers/services with no launcher icon, so
                    "no icon" is a normal outcome, not a failure. */}
                {icons[pkg] ? (
                  <img className="icon" src={icons[pkg]!} alt="" />
                ) : icons[pkg] === null ? (
                  <div className="icon none">
                    <Icon name="package" />
                  </div>
                ) : (
                  <div className="icon" />
                )}
                <span className="label">{shortName(pkg)}</span>
              </button>
            ))}
          </div>
        )}
        {iconTrouble && !diag && (
          <div
            className="row"
            style={{
              marginTop: 12,
              padding: "10px 14px",
              borderRadius: 12,
              background: "color-mix(in srgb, var(--warn) 12%, transparent)",
              color: "var(--warn)",
              fontSize: 12.5,
            }}
          >
            <Icon name="shield" />
            <span className="grow" style={{ flex: 1 }}>
              多数图标读取失败，点右侧「图标诊断」查看原因
            </span>
          </div>
        )}

        <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <span className="muted" style={{ fontSize: 12 }}>
            {list?.length ?? 0} 个应用
            {shown.length !== (list?.length ?? 0) && ` · 显示 ${shown.length}`}
          </span>
          {/* Icons failing is otherwise silent — a grey square looks the same as
              "no icon". This reports what each lookup step actually returned. */}
          <button
            className="btn sm ghost"
            disabled={!shown.length || diag !== null}
            title="图标不显示时，查看每一步返回了什么"
            onClick={() => {
              const pkg = selected ?? shown[0];
              setDiag(["正在诊断…"]);
              void apps
                .diagnoseIcon(active.adb, pkg)
                .then(setDiag)
                .catch((e) => setDiag([`诊断失败：${errorMessage(e)}`]));
            }}
          >
            图标诊断
          </button>
        </div>
        {diag && (
          <>
            <pre className="log" style={{ marginTop: 10 }}>
              {diag.join("\n")}
            </pre>
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn sm ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(diag.join("\n"));
                  toast("success", "已复制诊断结果");
                }}
              >
                复制
              </button>
              <button className="btn sm ghost" onClick={() => setDiag(null)}>
                关闭
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3>详情</h3>
        {!selected ? (
          <div className="muted" style={{ padding: 24, textAlign: "center" }}>
            选择一个应用
          </div>
        ) : (
          <>
            <div className="hero" style={{ marginBottom: 16 }}>
              {icons[selected] ? (
                <img
                  src={icons[selected]!}
                  alt=""
                  style={{ width: 60, height: 60, borderRadius: 16, flex: "none" }}
                />
              ) : (
                <div className="art">
                  <Icon name="package" />
                </div>
              )}
              <div style={{ minWidth: 0 }}>
                <div className="big" style={{ fontSize: 19 }}>
                  {shortName(selected)}
                </div>
                <div className="sub">{selected}</div>
              </div>
            </div>

            {detail ? (
              <div className="stats" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                <div className="stat">
                  <div className="k">版本</div>
                  <div className="v">
                    {detail.versionName ?? "—"}
                    {detail.versionCode ? ` (${detail.versionCode})` : ""}
                  </div>
                </div>
                <div className="stat">
                  <div className="k">类型</div>
                  <div className="v">{detail.isSystemApp ? "系统" : "第三方"}</div>
                </div>
                <div className="stat">
                  <div className="k">状态</div>
                  <div className="v">{detail.isEnabled ? "已启用" : "已禁用"}</div>
                </div>
                <div className="stat">
                  <div className="k">更新时间</div>
                  <div className="v mono">{detail.updateTime?.slice(0, 10) ?? "—"}</div>
                </div>
              </div>
            ) : (
              <div className="muted">读取中…</div>
            )}

            <div className="tiles" style={{ marginTop: 16 }}>
              <Tile
                icon="play"
                label="启动"
                tone="accent"
                disabled={working}
                onClick={() => void act("启动", () => apps.appLaunch(active.adb, selected))}
              />
              <Tile
                icon="stop"
                label="强停"
                disabled={working}
                onClick={() => void act("强制停止", () => apps.appForceStop(active.adb, selected))}
              />
              <Tile
                icon="trash"
                label="清数据"
                disabled={working}
                onClick={() => {
                  if (!confirm(`清除 ${selected} 的全部数据？不可撤销。`)) return;
                  void act("清除数据", () => apps.appClearData(active.adb, selected));
                }}
              />
              {detail && (
                <Tile
                  icon={detail.isEnabled ? "moon" : "sun"}
                  label={detail.isEnabled ? "禁用" : "启用"}
                  disabled={working}
                  onClick={() =>
                    void act(detail.isEnabled ? "禁用" : "启用", () =>
                      apps.appSetEnabled(active.adb, selected, !detail.isEnabled)
                    )
                  }
                />
              )}
              <Tile
                icon="del"
                label="卸载"
                tone="danger"
                disabled={working}
                onClick={() => {
                  if (!confirm(`卸载 ${selected}？`)) return;
                  void act("卸载", () => apps.appUninstall(active.adb, selected, false), true);
                }}
              />
            </div>

            <div
              style={{
                marginTop: 18,
                paddingTop: 16,
                borderTop: "1px solid var(--border)",
              }}
            >
              <Perf active={active} pkg={selected} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
