import { useStore } from "../store";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismiss);
  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="grow" style={{ flex: 1 }}>
            {t.message}
          </span>
          <button className="x" onClick={() => dismiss(t.id)} aria-label="关闭">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function BusyOverlay() {
  const busy = useStore((s) => s.busy);
  if (!busy) return null;
  return <div className="busy">{busy}</div>;
}
