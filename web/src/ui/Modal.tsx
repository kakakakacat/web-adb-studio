import { useEffect, type ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: string;
  onClose(): void;
  children: ReactNode;
  /** Rendered in the footer, right-aligned. */
  actions?: ReactNode;
}

export function Modal({ title, subtitle, onClose, children, actions }: Props) {
  // Escape closes; also stop the page behind from scrolling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="muted">{subtitle}</div>}
          </div>
          <button className="btn sm" onClick={onClose}>
            关闭
          </button>
        </div>
        <div style={{ marginTop: 16 }}>{children}</div>
        {actions && (
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
