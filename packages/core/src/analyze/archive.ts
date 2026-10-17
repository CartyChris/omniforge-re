/**
 * Safe archive handling (ZIP, TAR, TAR.GZ/TGZ, GZ) with Zip-Slip, symlink and
 * decompression-bomb protection.
 *
 * Budgets are enforced BEFORE inflating each entry (using the sizes declared in
 * the archive headers) and the inflated output is re-checked against the
 * declaration afterwards, so a header that lies cannot exceed the budget either.
 */
import { Gunzip, strFromU8, unzipSync, type UnzipFileInfo } from "fflate";

export class ArchiveError extends Error {}

export interface ArchiveEntry {
  path: string;
  bytes: number;
  data: Uint8Array;
}

export interface ArchiveReadOptions {
  maxTotalBytes?: number;
  maxEntryBytes?: number;
  maxEntries?: number;
  /** Max allowed ratio of inflated size to compressed size per entry. */
  maxRatio?: number;
}

export interface ArchiveResult {
  entries: ArchiveEntry[];
  skipped: string[];
  format: "zip" | "tar" | "tgz" | "gzip";
}

const DEFAULTS = { maxTotalBytes: 200_000_000, maxEntryBytes: 25_000_000, maxEntries: 20_000, maxRatio: 1000 };

/** Reject path traversal and absolute paths. Returns a normalised safe path. */
export function safeEntryPath(name: string): string | null {
  if (!name || name.endsWith("/")) return null;
  if (name.includes("\0")) return null;
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[a-z]:/i.test(n)) return null;
  const parts: string[] = [];
  for (const seg of n.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null; // zip-slip
    parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

export function detectArchive(buf: Uint8Array, name = ""): ArchiveResult["format"] | null {
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) return "zip";
  if (buf[0] === 0x1f && buf[1] === 0x8b) return /\.(tgz|tar\.gz)$/i.test(name) ? "tgz" : "gzip";
  if (buf.length > 262 && strFromU8(buf.subarray(257, 262)) === "ustar") return "tar";
  return null;
}

export function readZip(buf: Uint8Array, opts: ArchiveReadOptions = {}): ArchiveResult {
  const o = { ...DEFAULTS, ...opts };
  const skipped: string[] = [];
  let total = 0;
  let count = 0;
  const declared = new Map<string, number>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf, {
      filter(file: UnzipFileInfo) {
        const safe = safeEntryPath(file.name);
        if (!safe) {
          if (!file.name.endsWith("/")) skipped.push(`${file.name} (unsafe path)`);
          return false;
        }
        if (count >= o.maxEntries) {
          skipped.push(`${safe} (entry limit ${o.maxEntries} reached)`);
          return false;
        }
        if (file.originalSize > o.maxEntryBytes) {
          skipped.push(`${safe} (declared ${file.originalSize} bytes exceeds per-entry cap)`);
          return false;
        }
        if (file.size > 0 && file.originalSize / file.size > o.maxRatio) {
          skipped.push(`${safe} (compression ratio ${(file.originalSize / file.size).toFixed(0)}:1 exceeds ${o.maxRatio}:1; possible bomb)`);
          return false;
        }
        if (total + file.originalSize > o.maxTotalBytes) {
          skipped.push(`${safe} (total decompression budget ${o.maxTotalBytes} exhausted)`);
          return false;
        }
        total += file.originalSize;
        count++;
        declared.set(file.name, file.originalSize);
        return true;
      },
    });
  } catch (e) {
    throw new ArchiveError(`Not a valid zip archive: ${(e as Error).message}`);
  }
  const entries: ArchiveEntry[] = [];
  for (const [name, data] of Object.entries(files)) {
    const safe = safeEntryPath(name);
    if (!safe) continue;
    if (data.byteLength > (declared.get(name) ?? Infinity) || data.byteLength > o.maxEntryBytes) {
      skipped.push(`${safe} (inflated size disagrees with header; dropped)`);
      continue;
    }
    entries.push({ path: safe, bytes: data.byteLength, data });
  }
  return { entries, skipped, format: "zip" };
}

function octal(b: Uint8Array, off: number, len: number): number {
  const s = strFromU8(b.subarray(off, off + len)).replace(/\0.*$/, "").trim();
  return s ? parseInt(s, 8) : 0;
}

export function readTar(buf: Uint8Array, opts: ArchiveReadOptions = {}): ArchiveResult {
  const o = { ...DEFAULTS, ...opts };
  const entries: ArchiveEntry[] = [];
  const skipped: string[] = [];
  let off = 0;
  let total = 0;
  let longName: string | null = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((x) => x === 0)) break;
    let name = strFromU8(header.subarray(0, 100)).replace(/\0.*$/, "");
    const prefix = strFromU8(header.subarray(345, 500)).replace(/\0.*$/, "");
    if (prefix) name = `${prefix}/${name}`;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = off + 512;
    const next = dataStart + Math.ceil(size / 512) * 512;
    if (dataStart + size > buf.length) throw new ArchiveError("Truncated tar archive");
    if (type === "L") {
      longName = strFromU8(buf.subarray(dataStart, dataStart + size)).replace(/\0.*$/, "");
    } else if (type === "x" || type === "g") {
      const pax = strFromU8(buf.subarray(dataStart, dataStart + size));
      const m = pax.match(/\d+ path=([^\n]+)\n/);
      if (m && type === "x") longName = m[1]!;
    } else {
      const finalName = longName ?? name;
      longName = null;
      if (type === "0" || type === "\0" || type === "7") {
        const safe = safeEntryPath(finalName);
        if (!safe) skipped.push(`${finalName} (unsafe path)`);
        else if (entries.length >= o.maxEntries) skipped.push(`${safe} (entry limit reached)`);
        else if (size > o.maxEntryBytes) skipped.push(`${safe} (${size} bytes exceeds per-entry cap)`);
        else if (total + size > o.maxTotalBytes) skipped.push(`${safe} (total budget exhausted)`);
        else {
          total += size;
          entries.push({ path: safe, bytes: size, data: buf.slice(dataStart, dataStart + size) });
        }
      } else if (type === "1" || type === "2") {
        skipped.push(`${finalName} (links are not followed)`);
      }
    }
    off = next;
  }
  return { entries, skipped, format: "tar" };
}

/** Streaming gunzip that aborts the moment output exceeds `max` (bomb-safe). */
export function boundedGunzip(buf: Uint8Array, max: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const gz = new Gunzip((chunk) => {
    total += chunk.byteLength;
    if (total > max) throw new ArchiveError(`Decompressed gzip exceeds budget ${max} bytes; aborted`);
    chunks.push(chunk);
  });
  try {
    gz.push(buf, true);
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    throw new ArchiveError(`Invalid gzip stream: ${(e as Error).message}`);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Read any supported archive. Gzip is inflated under the same total budget. */
export function readArchive(buf: Uint8Array, name = "", opts: ArchiveReadOptions = {}): ArchiveResult {
  const o = { ...DEFAULTS, ...opts };
  const kind = detectArchive(buf, name);
  if (kind === "zip") return readZip(buf, opts);
  if (kind === "tar") return readTar(buf, opts);
  if (kind === "gzip" || kind === "tgz") {
    const inflated = boundedGunzip(buf, o.maxTotalBytes);
    if (detectArchive(inflated, "") === "tar") return { ...readTar(inflated, opts), format: "tgz" };
    const base = name.replace(/\.gz$/i, "") || "file";
    return { entries: [{ path: safeEntryPath(base) ?? "file", bytes: inflated.byteLength, data: inflated }], skipped: [], format: "gzip" };
  }
  throw new ArchiveError("Unrecognised archive format (expected zip, tar, tgz or gzip)");
}

/** Strip a single common top-level directory (GitHub-style `repo-main/`). */
export function stripCommonRoot(entries: ArchiveEntry[]): ArchiveEntry[] {
  if (!entries.length) return entries;
  const first = entries[0]!.path.split("/")[0]!;
  if (entries.every((e) => e.path.split("/")[0] === first && e.path.includes("/"))) {
    return entries.map((e) => ({ ...e, path: e.path.slice(first.length + 1) }));
  }
  return entries;
}

export function decodeText(data: Uint8Array): string {
  return strFromU8(data);
}
