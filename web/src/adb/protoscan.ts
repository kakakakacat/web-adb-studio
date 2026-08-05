// Protobuf wire-format walker.
//
// The app uses protobuf-**lite**, which has no descriptors at runtime — the device
// physically cannot tell us field names, so it sends the raw bytes and we make the
// most of them here. What the wire format does carry is field numbers, wire types,
// and enough structure to guess nesting:
//
//   1 → "field 3: 1699 (varint)"
//   2 → a string if it decodes as printable UTF-8, a nested message if it parses
//       as one, otherwise hex
//
// Field *names* need a `descriptor_set.pb` from the build. That's a follow-up; this
// gets a readable tree with zero build changes and zero dependencies, which is what
// makes "is the request actually carrying what I think" answerable today.

export interface ProtoField {
  field: number;
  wire: number;
  /** Rendered value for display. */
  value: string;
  /** Set when the value parsed as a nested message. */
  nested?: ProtoField[];
  /** Bytes, for the hex view of this one field. */
  raw?: Uint8Array;
}

export interface ProtoScan {
  ok: boolean;
  fields: ProtoField[];
}

/** Parse as a protobuf message. `ok: false` means it almost certainly isn't one. */
export function scan(bytes: Uint8Array, depth = 0): ProtoScan {
  const fields: ProtoField[] = [];
  let at = 0;
  while (at < bytes.length) {
    const key = varint(bytes, at);
    if (!key) return { ok: false, fields };
    at = key.next;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    // Field 0 is illegal and wire types 6/7 don't exist: a reliable "this is not
    // protobuf" signal, which is most of what makes this heuristic usable.
    if (field === 0 || wire === 6 || wire === 7) return { ok: false, fields };

    if (wire === 0) {
      const v = varint(bytes, at);
      if (!v) return { ok: false, fields };
      at = v.next;
      fields.push({ field, wire, value: `${v.value}` });
    } else if (wire === 1) {
      if (at + 8 > bytes.length) return { ok: false, fields };
      const raw = bytes.subarray(at, at + 8);
      const f64 = new DataView(raw.buffer, raw.byteOffset, 8).getFloat64(0, true);
      fields.push({ field, wire, value: `${f64} (fixed64)`, raw });
      at += 8;
    } else if (wire === 5) {
      if (at + 4 > bytes.length) return { ok: false, fields };
      const raw = bytes.subarray(at, at + 4);
      const f32 = new DataView(raw.buffer, raw.byteOffset, 4).getFloat32(0, true);
      fields.push({ field, wire, value: `${f32} (fixed32)`, raw });
      at += 4;
    } else if (wire === 2) {
      const len = varint(bytes, at);
      if (!len) return { ok: false, fields };
      const start = len.next;
      const end = start + len.value;
      if (end > bytes.length) return { ok: false, fields };
      const raw = bytes.subarray(start, end);
      fields.push({ field, wire, ...describeBytes(raw, depth), raw });
      at = end;
    } else {
      // 3/4 are the deprecated groups; nothing generates them any more.
      return { ok: false, fields };
    }
  }
  return { ok: fields.length > 0, fields };
}

function describeBytes(
  raw: Uint8Array,
  depth: number
): { value: string; nested?: ProtoField[] } {
  if (raw.length === 0) return { value: '""' };
  // Try nested first: a submessage that also decodes as text is far more likely to
  // be a submessage, and the text view is one click away in the raw pane anyway.
  if (depth < 6) {
    const inner = scan(raw, depth + 1);
    if (inner.ok) return { value: `{${inner.fields.length} 字段}`, nested: inner.fields };
  }
  const text = printableText(raw);
  if (text !== undefined) return { value: JSON.stringify(text) };
  return { value: `${raw.length} 字节 · ${hex(raw, 16)}` };
}

/** UTF-8 that is actually printable, else undefined. */
export function printableText(raw: Uint8Array): string | undefined {
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return undefined;
  }
  // Control characters (tab/CR/LF excepted) mean it is binary that happens to be
  // valid UTF-8 — common for small protobufs.
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s) ? undefined : s;
}

function varint(b: Uint8Array, at: number): { value: number; next: number } | undefined {
  let value = 0;
  let shift = 1;
  for (let i = at; i < b.length && i < at + 10; i++) {
    value += (b[i] & 0x7f) * shift;
    if ((b[i] & 0x80) === 0) return { value, next: i + 1 };
    shift *= 128;
  }
  return undefined;
}

export function hex(bytes: Uint8Array, limit = bytes.length): string {
  let out = "";
  for (let i = 0; i < Math.min(bytes.length, limit); i++) {
    out += bytes[i].toString(16).padStart(2, "0");
    if (i % 2 === 1) out += " ";
  }
  return out.trim() + (bytes.length > limit ? " …" : "");
}

/** Classic hex dump with an ASCII gutter, for the Hex tab. */
export function hexDump(bytes: Uint8Array, limit = 8192): string {
  const lines: string[] = [];
  const n = Math.min(bytes.length, limit);
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n));
    let h = "";
    let a = "";
    for (let i = 0; i < 16; i++) {
      h += i < row.length ? row[i].toString(16).padStart(2, "0") + " " : "   ";
      if (i === 7) h += " ";
      if (i < row.length) a += row[i] >= 0x20 && row[i] < 0x7f ? String.fromCharCode(row[i]) : ".";
    }
    lines.push(`${off.toString(16).padStart(8, "0")}  ${h} |${a}|`);
  }
  if (bytes.length > n) lines.push(`… 还有 ${bytes.length - n} 字节`);
  return lines.join("\n");
}
