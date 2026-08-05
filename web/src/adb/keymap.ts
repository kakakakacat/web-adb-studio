// Browser key -> Android keycode.
//
// Only the keys that can't be delivered as text: printable characters go through
// `injectText` (and anything non-ASCII through the clipboard), because expressing
// them as keycodes would mean replicating a keyboard layout here.

export const META = {
  none: 0,
  shift: 1,
  ctrl: 0x1000,
  alt: 2,
} as const;

/** KeyboardEvent.code -> Android keycode. */
export const KEY_CODES: Record<string, number> = {
  Enter: 66,
  NumpadEnter: 66,
  Backspace: 67,
  Tab: 61,
  Escape: 111,
  Space: 62,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  Delete: 112,
  Insert: 124,
  F1: 131,
  F2: 132,
  F3: 133,
  F4: 134,
  F5: 135,
  F6: 136,
  F7: 137,
  F8: 138,
  F9: 139,
  F10: 140,
  F11: 141,
  F12: 142,
};

/** Android meta-state bitmask for the modifiers held during an event. */
export function metaStateOf(e: {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): number {
  return (
    (e.shiftKey ? META.shift : 0) |
    (e.ctrlKey ? META.ctrl : 0) |
    (e.altKey ? META.alt : 0)
  );
}

/** True when the character can be sent as text rather than as a keycode. */
export function isPrintableAscii(key: string): boolean {
  return key.length === 1 && key >= " " && key <= "~";
}
