import { useCallback, useEffect, useRef, useState } from "react";
import { LinuxFileType } from "@yume-chan/adb";

import * as files from "../adb/files";
import { Icon, Tile } from "./Icon";
import { useStore, type Active } from "../store";
import { errorMessage, type TransferProgress } from "../types";

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

interface Entry {
  name: string;
  isDirectory: boolean;
  size: number;
}

export function Files({ active }: { active: Active }) {
  const toast = useStore((s) => s.toast);
  const prepareSystemWrite = useStore((s) => s.prepareSystemWrite);
  const [dir, setDir] = useState(files.DEFAULT_PUSH_DIR);
  const [pushDir, setPushDir] = useState(files.DEFAULT_PUSH_DIR);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const apkInput = useRef<HTMLInputElement>(null);

  const browse = useCallback(
    async (path: string) => {
      setEntries(null);
      try {
        const list = await files.listDir(active.adb, path);
        setEntries(
          list
            .filter((e) => e.name !== "." && e.name !== "..")
            .map((e) => ({
              name: e.name,
              isDirectory: e.type === LinuxFileType.Directory,
              size: Number(e.size),
            }))
            .sort(
              (a, b) =>
                Number(b.isDirectory) - Number(a.isDirectory) ||
                a.name.localeCompare(b.name)
            )
        );
        setDir(path);
      } catch (e) {
        setEntries([]);
        toast("error", `无法列出 ${path}：${errorMessage(e)}`);
      }
    },
    [active.adb, toast]
  );

  useEffect(() => {
    void browse(files.DEFAULT_PUSH_DIR);
  }, [browse]);

  async function push(list: File[]) {
    if (list.length === 0) return;
    setProgress(null);
    try {
      await files.pushFiles(active.adb, list, pushDir, setProgress);
      toast("success", `已推送 ${list.length} 个文件到 ${pushDir}`);
      if (pushDir === dir) await browse(dir);
    } catch (e) {
      toast("error", `推送失败：${errorMessage(e)}`);
    } finally {
      setProgress(null);
    }
  }

  async function install(file: File) {
    setLog([]);
    setProgress(null);
    try {
      await files.installApk(
        active.adb,
        file,
        setProgress,
        (line) => setLog((prev) => [...prev, line]),
        prepareSystemWrite
      );
      toast("success", `${file.name} 安装成功`);
    } catch (e) {
      toast("error", `安装失败：${errorMessage(e)}`);
    } finally {
      setProgress(null);
    }
  }

  const parent = dir.replace(/\/[^/]+\/?$/, "") || "/";

  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
      <div className="card">
        <h3>推送文件到设备</h3>
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="muted">目标目录</span>
          <input
            type="text"
            className="mono"
            style={{ flex: 1 }}
            value={pushDir}
            onChange={(e) => setPushDir(e.target.value)}
          />
        </div>

        <div
          className={`drop ${over ? "over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void push([...e.dataTransfer.files]);
          }}
          onClick={() => fileInput.current?.click()}
        >
          <Icon name="upload" />
          <span className="big">把文件拖到这里</span>
          <span style={{ fontSize: 12 }}>或点击选择</span>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void push([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </div>

        <div className="tiles" style={{ marginTop: 16, gridTemplateColumns: "repeat(2, 1fr)" }}>
          <Tile icon="package" label="安装 APK" tone="accent" onClick={() => apkInput.current?.click()} />
          <Tile icon="folder" label="选择文件" onClick={() => fileInput.current?.click()} />
        </div>
        <input
          ref={apkInput}
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void install(f);
            e.target.value = "";
          }}
        />

        {progress && (
          <div style={{ marginTop: 16 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="mono">{progress.fileName}</span>
              <span className="muted">
                {progress.total > 1 && `${progress.index + 1}/${progress.total} · `}
                {human(progress.bytesTransferred)} / {human(progress.totalBytes)}
                {progress.speedBytesPerSecond > 0 &&
                  ` · ${human(progress.speedBytesPerSecond)}/s`}
              </span>
            </div>
            <div className="bar" style={{ marginTop: 6 }}>
              <i style={{ width: `${Math.min(100, progress.percent * 100)}%` }} />
            </div>
          </div>
        )}

        {log.length > 0 && (
          <pre className="log" style={{ marginTop: 12 }}>
            {log.join("\n")}
          </pre>
        )}
      </div>

      <div className="card">
        <h3>设备文件</h3>
        <div className="row" style={{ marginBottom: 12 }}>
          <input
            type="text"
            className="mono"
            style={{ flex: 1 }}
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void browse(dir);
            }}
          />
          <button className="btn sm" onClick={() => void browse(dir)}>
            打开
          </button>
          <button className="btn sm" onClick={() => void browse(parent)}>
            上一级
          </button>
        </div>

        {entries === null ? (
          <div className="muted">读取中…</div>
        ) : entries.length === 0 ? (
          <div className="muted">空目录，或无权限访问</div>
        ) : (
          <div className="list scroll">
            {entries.map((e) => {
              const full = dir.endsWith("/") ? `${dir}${e.name}` : `${dir}/${e.name}`;
              return (
                <div key={e.name} className="list-row">
                  <Icon name={e.isDirectory ? "folder" : "file"} />
                  {e.isDirectory ? (
                    <button
                      className="grow"
                      style={{
                        background: "none",
                        border: 0,
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                      onClick={() => void browse(full)}
                    >
                      {e.name}
                    </button>
                  ) : (
                    <span className="grow">{e.name}</span>
                  )}
                  {!e.isDirectory && (
                    <>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {human(e.size)}
                      </span>
                      <button
                        className="btn sm"
                        onClick={() =>
                          void files
                            .pullToDownload(active.adb, full)
                            .catch((err) => toast("error", errorMessage(err)))
                        }
                      >
                        下载
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
