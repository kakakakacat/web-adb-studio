// Reading an APK in the browser: package name, and the native libraries inside.
//
// The native app shelled out to `aapt`. There is no aapt here, and the decision
// this feeds — system push vs `pm install` — has to be made *before* anything
// touches the device, so it can't be answered by asking Android either. So we
// open the APK ourselves: it's a zip, and AndroidManifest.xml inside it is
// Android's binary XML, which is a compact enough format to read directly.
//
// Only what's needed is implemented: the string pool and the first START_ELEMENT.
// Nothing here tries to be a general AXML decoder.

/** One file inside the zip, located but not yet read. */
interface ZipEntry {
  name: string;
  /** Offset of the local file header, not the data — the name length lives there. */
  headerOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate. Anything else we refuse rather than guess. */
  method: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

async function slice(file: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

/**
 * Read the zip central directory.
 *
 * Scans backwards for the end-of-central-directory record, which is what makes
 * this work on a File without reading the whole thing: an APK is tens of
 * megabytes and only a few kilobytes of it are interesting.
 */
export async function zipEntries(file: Blob): Promise<Map<string, ZipEntry>> {
  // The EOCD is 22 bytes plus a comment of up to 64 KB.
  const tailLength = Math.min(file.size, 66 * 1024);
  const tail = await slice(file, file.size - tailLength, file.size);

  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 APK/ZIP（找不到目录结尾）");

  const count = tail.getUint16(eocd + 10, true);
  const cenSize = tail.getUint32(eocd + 12, true);
  const cenOffset = tail.getUint32(eocd + 16, true);

  const cen = await slice(file, cenOffset, cenOffset + cenSize);
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();

  let p = 0;
  for (let i = 0; i < count && p + 46 <= cen.byteLength; i++) {
    if (cen.getUint32(p, true) !== CEN_SIG) break;
    const method = cen.getUint16(p + 10, true);
    const compressedSize = cen.getUint32(p + 20, true);
    const uncompressedSize = cen.getUint32(p + 24, true);
    const nameLen = cen.getUint16(p + 28, true);
    const extraLen = cen.getUint16(p + 30, true);
    const commentLen = cen.getUint16(p + 32, true);
    const headerOffset = cen.getUint32(p + 42, true);
    const name = decoder.decode(
      new Uint8Array(cen.buffer, cen.byteOffset + p + 46, nameLen)
    );
    entries.set(name, { name, headerOffset, compressedSize, uncompressedSize, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decompress one entry. */
export async function readEntry(file: Blob, entry: ZipEntry): Promise<Uint8Array> {
  // The local header repeats the name and extra field, with its own lengths —
  // the central directory's extra length is often different, so it can't be
  // reused to find the data.
  const local = await slice(file, entry.headerOffset, entry.headerOffset + 30);
  const nameLen = local.getUint16(26, true);
  const extraLen = local.getUint16(28, true);
  const start = entry.headerOffset + 30 + nameLen + extraLen;
  const raw = file.slice(start, start + entry.compressedSize);

  if (entry.method === 0) return new Uint8Array(await raw.arrayBuffer());
  if (entry.method !== 8) {
    throw new Error(`不支持的压缩方式 ${entry.method}（${entry.name}）`);
  }
  // "deflate-raw" — zip stores a bare deflate stream with no zlib wrapper.
  const stream = raw.stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- Android binary XML ----------------------------------------------------

const RES_STRING_POOL = 0x0001;
const RES_XML_START_ELEMENT = 0x0102;
const UTF8_FLAG = 1 << 8;

/** The string pool: every name and string value in the document. */
function readStringPool(view: DataView, start: number): string[] {
  const stringCount = view.getUint32(start + 8, true);
  const flags = view.getUint32(start + 16, true);
  const stringsStart = view.getUint32(start + 20, true);
  const utf8 = (flags & UTF8_FLAG) !== 0;

  const strings: string[] = [];
  const decoder = new TextDecoder(utf8 ? "utf-8" : "utf-16le");
  for (let i = 0; i < stringCount; i++) {
    const offset = start + stringsStart + view.getUint32(start + 28 + i * 4, true);
    if (utf8) {
      // Two lengths, each 1 or 2 bytes: characters then bytes. Only the second
      // matters for slicing.
      let p = offset;
      const skip = (): number => {
        const first = view.getUint8(p++);
        if (first & 0x80) return ((first & 0x7f) << 8) | view.getUint8(p++);
        return first;
      };
      skip();
      const byteLen = skip();
      strings.push(decoder.decode(new Uint8Array(view.buffer, view.byteOffset + p, byteLen)));
    } else {
      let p = offset;
      let charLen = view.getUint16(p, true);
      p += 2;
      if (charLen & 0x8000) {
        charLen = ((charLen & 0x7fff) << 16) | view.getUint16(p, true);
        p += 2;
      }
      strings.push(
        decoder.decode(new Uint8Array(view.buffer, view.byteOffset + p, charLen * 2))
      );
    }
  }
  return strings;
}

/**
 * The `package` attribute of the `<manifest>` element.
 *
 * Attribute values can be either a raw string index or a typed value; the
 * package is always a plain string, so the raw index is enough and there is no
 * need to interpret the typed-value union.
 */
export function axmlPackageName(bytes: Uint8Array): string | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let strings: string[] = [];

  // Chunked format: an 8-byte header (type, headerSize, size) then the body.
  let p = 8; // skip the file header
  while (p + 8 <= view.byteLength) {
    const type = view.getUint16(p, true);
    const size = view.getUint32(p + 4, true);
    if (size <= 0 || p + size > view.byteLength) break;

    if (type === RES_STRING_POOL) {
      strings = readStringPool(view, p);
    } else if (type === RES_XML_START_ELEMENT) {
      const headerSize = view.getUint16(p + 2, true);
      const nameIndex = view.getUint32(p + headerSize + 4, true);
      if (strings[nameIndex] === "manifest") {
        const attrStart = view.getUint16(p + headerSize + 8, true);
        const attrSize = view.getUint16(p + headerSize + 10, true);
        const attrCount = view.getUint16(p + headerSize + 12, true);
        for (let i = 0; i < attrCount; i++) {
          const a = p + headerSize + attrStart + i * attrSize;
          const attrName = strings[view.getUint32(a + 4, true)];
          if (attrName !== "package") continue;
          const rawValue = view.getUint32(a + 8, true);
          if (rawValue !== 0xffffffff) return strings[rawValue];
          // Some builders leave rawValue unset and put the index in the typed
          // value's data field instead.
          return strings[view.getUint32(a + 16, true)];
        }
        // The manifest element is the first one; no point walking the rest.
        return undefined;
      }
    }
    p += size;
  }
  return undefined;
}

/** Package name declared by an APK, or undefined if it can't be read. */
export async function apkPackageName(file: Blob): Promise<string | undefined> {
  try {
    const entries = await zipEntries(file);
    const manifest = entries.get("AndroidManifest.xml");
    if (!manifest) return undefined;
    return axmlPackageName(await readEntry(file, manifest));
  } catch {
    // A malformed or unusual APK must not block installing it the normal way.
    return undefined;
  }
}

/**
 * The `.so` files for one ABI, as the system-app push has to refresh them
 * separately: overwriting `base.apk` in place leaves the extracted libraries
 * from the previous build in `lib/`, and a stale `.so` against a new APK
 * crashes the app at load time.
 */
export async function apkNativeLibs(
  file: Blob,
  abi = "arm64-v8a"
): Promise<{ name: string; bytes: Uint8Array }[]> {
  const entries = await zipEntries(file);
  const prefix = `lib/${abi}/`;
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const entry of entries.values()) {
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".so")) continue;
    out.push({
      name: entry.name.slice(prefix.length),
      bytes: await readEntry(file, entry),
    });
  }
  return out;
}
