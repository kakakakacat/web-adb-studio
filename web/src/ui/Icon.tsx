// Inline stroke icons. Hand-rolled rather than pulled from a library: we need a
// dozen, and the bundle is already 385 KB of ADB implementation.

const PATHS: Record<string, string> = {
  phone: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM10 19h4",
  camera:
    "M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3l-1.5-2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  download: "M12 3v12m0 0 4-4m-4 4-4-4M4 21h16",
  upload: "M12 21V9m0 0 4 4m-4-4-8 4M4 3h16",
  refresh: "M21 12a9 9 0 1 1-3-6.7M21 4v5h-5",
  power: "M12 3v9m5.6-6.6a8 8 0 1 1-11.2 0",
  restart: "M3 12a9 9 0 1 0 9-9 9 9 0 0 0-7.4 3.9M3 4v4h4",
  wrench:
    "M14.7 6.3a4 4 0 0 0 5 5l-9.8 9.8a2.8 2.8 0 0 1-4-4l9.8-9.8a4 4 0 0 0-1 1z",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  home: "M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5",
  back: "M19 12H5m0 0 6-6m-6 6 6 6",
  square: "M6 6h12v12H6z",
  volumeUp: "M11 5 6 9H3v6h3l5 4V5zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12",
  volumeDown: "M11 5 6 9H3v6h3l5 4V5zM16 9a4 4 0 0 1 0 6",
  sun: "M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m11.4 0 1.4 1.4M4.9 4.9l1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  moon: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z",
  send: "M4 12l16-8-6 16-2.5-6.5L4 12z",
  keyboard:
    "M4 7h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM7 11h.01M11 11h.01M15 11h.01M8 14h8",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zM14 3v5h5",
  package: "M12 2 3 7v10l9 5 9-5V7l-9-5zM3 7l9 5 9-5M12 12v10",
  trash: "M4 7h16M9 7V4h6v3m-8 0 1 14h8l1-14",
  play: "M7 4l13 8-13 8V4z",
  stop: "M7 7h10v10H7z",
  rotate: "M4 9a8 8 0 0 1 14-3M20 15a8 8 0 0 1-14 3M18 3v4h-4M6 21v-4h4",
  cast: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5M3 12a6 6 0 0 1 6 6M3 16a2 2 0 0 1 2 2M4 20h.01",
  usb: "M12 21V7m0 0-3 3m3-3 3 3M12 3v1M8 14l-3 2v3m11-5 3 2v3",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.4-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z",
  plus: "M12 5v14M5 12h14",
  check: "M4 13l5 5L20 7",
  cloud: "M18 18a4 4 0 0 0-1-7.9A6 6 0 0 0 6 11a4 4 0 0 0 0 7h12z",
  server: "M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01",
  coin: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v8m-2.5-5.5h5",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  del: "M20 6H9L3 12l6 6h11a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1zM17 10l-5 4m0-4 5 4",
  enter: "M9 10l-4 4 4 4M5 14h9a5 5 0 0 0 5-5V6",
};

export type IconName = keyof typeof PATHS | string;

export function Icon({ name, size }: { name: IconName; size?: number }) {
  const d = PATHS[name] ?? PATHS.square;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...(size ? { width: size, height: size } : {})}
    >
      <path d={d} />
    </svg>
  );
}

/** A large square action button: icon above a short label. */
export function Tile({
  icon,
  label,
  onClick,
  disabled,
  tone,
  title,
}: {
  icon: IconName;
  label: string;
  onClick(): void;
  disabled?: boolean;
  tone?: "accent" | "danger";
  title?: string;
}) {
  return (
    <button
      className={`tile ${tone ?? ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
    >
      <Icon name={icon} />
      {label}
    </button>
  );
}
