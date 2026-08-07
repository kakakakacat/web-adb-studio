import { useStore } from "../store";
import { Icon } from "./Icon";
import type { Device } from "../types";

function stateLabel(d: Device) {
  if (d.state === "unauthorized") return <span className="pill warn">未授权</span>;
  if (d.state === "offline") return <span className="pill">离线</span>;
  return null;
}

/** The device is there, but a local adb server owns the interface. */
function blockedLabel(d: Device, blocked: { serial: string } | null) {
  if (blocked?.serial !== d.serial) return null;
  return <span className="pill bad">被占用</span>;
}

function sourceLabel(d: Device) {
  // Worth showing: it tells the user whether this device is competing with a
  // local adb server (webusb) or sharing it (bridge).
  if (d.source === "bridge") {
    return <span className="pill ok">桥接</span>;
  }
  return <span className="pill">USB</span>;
}

export function Sidebar() {
  const devices = useStore((s) => s.devices);
  const active = useStore((s) => s.active);
  const select = useStore((s) => s.select);
  const addUsbDevice = useStore((s) => s.addUsbDevice);
  const refreshDevices = useStore((s) => s.refreshDevices);
  const blocked = useStore((s) => s.blocked);

  return (
    <aside className="sidebar">
      <div className="side-head">
        <span>设备</span>
        <button className="btn sm ghost" onClick={() => void refreshDevices()} title="刷新">
          <Icon name="refresh" />
        </button>
      </div>

      {devices.length === 0 && (
        <div style={{ padding: "8px 14px" }} className="muted">
          还没有设备
        </div>
      )}

      {devices.map((d) => (
        <button
          key={d.id}
          className={`device ${active?.device.serial === d.serial ? "active" : ""}`}
          onClick={() => void select(d)}
        >
          <div className="phone">
            <Icon name="phone" />
          </div>
          <div className="grow">
            <div className="name">{d.model ?? d.name}</div>
            <div className="sub">{d.serial}</div>
          </div>
          {blockedLabel(d, blocked) ?? stateLabel(d)}
          {sourceLabel(d)}
        </button>
      ))}

      <div className="side-foot">
        <button className="btn primary" onClick={() => void addUsbDevice()}>
          <Icon name="plus" />
          连接 USB 设备
        </button>
      </div>
    </aside>
  );
}
