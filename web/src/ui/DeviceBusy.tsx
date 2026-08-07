// "这台设备被本机的 adb 占着" —— 一个常驻的说明，不是一条会消失的 toast。
//
// Why this screen exists: the USB interface is exclusive. When a local adb server
// holds it, the page can still *list* the device (WebUSB tells us about devices we
// were granted, connected or not) but cannot open it. The result, before this
// screen, was a sidebar showing a phone by name over an empty page — every symptom
// of a broken app, with the one sentence that explains it living in a toast that
// had already faded.
//
// So it states the cause, and offers both exits with their costs: kill the adb
// server (browser gets the device, Android Studio loses it) or run the bridge
// (both, at the price of a 700 KB program). See BRIDGE.md.

import { useState } from "react";

import { useStore } from "../store";
import { DiagUpload } from "./DiagUpload";
import { Icon } from "./Icon";

const KILL = "adb kill-server";

export function DeviceBusy({
  blocked,
  onHelp,
}: {
  blocked: { serial: string; name: string };
  onHelp(): void;
}) {
  const devices = useStore((s) => s.devices);
  const select = useStore((s) => s.select);
  const rescueBusy = useStore((s) => s.rescueBusy);
  const toast = useStore((s) => s.toast);
  const [copied, setCopied] = useState(false);

  const device = devices.find((d) => d.serial === blocked.serial);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(KILL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard needs a secure context and a permission; the command is on
      // screen anyway, so this is not worth an error dialog.
      toast("info", `手动执行：${KILL}`);
    }
  };

  return (
    <div className="empty">
      <div className="box busybox">
        <div className="art warn">
          <Icon name="usb" />
        </div>
        <h2>{blocked.name} 被本机的 adb 占着</h2>
        <p>
          USB 调试接口是<strong>独占</strong>的：本机的 adb server 拿着它，浏览器就打不开。
          左边能看到这台设备，是因为你之前授权过 —— 不代表现在连上了。
          <br />
          Android Studio 一启动就会拉起一个 adb server，这是最常见的原因。
        </p>

        <div className="ways">
          <div className="way">
            <div className="k">
              <span className="pill">办法一</span> 让浏览器独占
            </div>
            <p>
              退出 Android Studio，然后在终端执行下面这条，再点「重试连接」。
              之后 adb 再起来也抢不走。
            </p>
            <div className="row">
              <code className="mono">{KILL}</code>
              <button className="btn sm ghost" onClick={() => void copy()}>
                <Icon name={copied ? "check" : "file"} />
                {copied ? "已复制" : "复制"}
              </button>
            </div>
          </div>

          <div className="way">
            <div className="k">
              <span className="pill ok">办法二</span> 和 Android Studio 同时用
            </div>
            <p>
              跑一个几百 KB 的本机桥接程序，浏览器就成了这个 adb server 的另一个客户端 ——
              谁都不用退出。齿轮里有对应系统的下载。
            </p>
            <div className="row">
              <button className="btn sm" onClick={onHelp}>
                <Icon name="settings" />
                下载 / 设置桥接
              </button>
              <button className="btn sm ghost" onClick={() => void rescueBusy()}>
                <Icon name="refresh" />
                桥接已在跑，重新探测
              </button>
            </div>
          </div>
        </div>

        <div className="row" style={{ justifyContent: "center", marginTop: 4 }}>
          <button
            className="btn primary"
            disabled={!device}
            onClick={() => device && void select(device)}
          >
            <Icon name="refresh" />
            重试连接
          </button>
        </div>

        {/* 两条路都试过还是不行时的出口：把这台机器上发生的事发过来，而不是靠转述。 */}
        <div className="diagfoot">
          <p className="muted">
            两个办法都不管用？把这台机器的诊断日志传上来 —— 只含尝试过程、浏览器能力和
            设备序列号，不含文件内容和屏幕内容。
          </p>
          <DiagUpload />
        </div>
      </div>
    </div>
  );
}
