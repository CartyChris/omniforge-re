/**
 * Static inspection of application packages and executables. Nothing is ever
 * executed. Built-in parsers (Mach-O/ELF/PE/WASM headers, ASAR, ZIP-based
 * packages, Apple bundles) work with no external tools; deeper analysis is
 * delegated to REA when the user chooses.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { readZip, sha256, type InputFile } from "@omniforge/core";
import { exec, which } from "./detect.js";

export type ArtifactKind = "macho" | "macho-universal" | "elf" | "pe" | "dotnet" | "wasm" | "asar" | "zip" | "apk" | "ipa" | "jar" | "crx" | "dmg" | "app-bundle" | "directory" | "unknown";

const MACHO_CPU: Record<number, string> = { 7: "x86", 0x01000007: "x86_64", 12: "arm", 0x0100000c: "arm64", 0x0200000c: "arm64_32", 18: "ppc", 0x01000012: "ppc64" };
const MACHO_FILETYPE: Record<number, string> = { 1: "object", 2: "executable", 3: "fvmlib", 4: "core", 5: "preload", 6: "dylib", 7: "dylinker", 8: "bundle", 9: "dylib stub", 10: "dsym", 11: "kext" };
const ELF_MACHINE: Record<number, string> = { 3: "x86", 8: "mips", 20: "ppc", 21: "ppc64", 40: "arm", 62: "x86_64", 183: "aarch64", 243: "riscv" };
const ELF_TYPE: Record<number, string> = { 1: "relocatable", 2: "executable", 3: "shared object / PIE", 4: "core" };
const PE_MACHINE: Record<number, string> = { 0x14c: "x86", 0x8664: "x86_64", 0x1c0: "arm", 0xaa64: "arm64" };

export interface BinaryInfo { kind: ArtifactKind; format: string; architectures: string[]; fileType?: string; bits?: 32 | 64; sections?: number; notes: string[]; strings?: { urls: string[]; paths: string[]; emails: string[]; libraries: string[] }; sha256: string; bytes: number; extra?: Record<string, unknown> }

export function sniffKind(b: Uint8Array): ArtifactKind {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 4) return "unknown";
  const m = dv.getUint32(0, false);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(m)) return "macho";
  if (m === 0xcafebabe || m === 0xbebafeca) return b.length > 8 && dv.getUint32(4, false) < 40 ? "macho-universal" : "jar";
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return "elf";
  if (b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d) return "wasm";
  if (b[0] === 0x4d && b[1] === 0x5a) return "pe";
  if (b[0] === 0x50 && b[1] === 0x4b) return "zip";
  if (b.length > 16 && dv.getUint32(0, true) === 4 && dv.getUint32(8, true) > 0 && b[16] === 0x7b) return "asar";
  if (b[0] === 0x78 && b[1] === 0x01 && b.length > 512 && String.fromCharCode(...b.subarray(b.length - 512, b.length - 508)) === "koly") return "dmg";
  return "unknown";
}

function extractStrings(b: Uint8Array, max = 4_000_000) {
  const s = Buffer.from(b.subarray(0, max)).toString("latin1");
  const uniq = (a: RegExpMatchArray | null, n: number) => [...new Set(a ?? [])].slice(0, n);
  return {
    urls: uniq(s.match(/https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{6,200}/g), 60),
    paths: uniq(s.match(/(?:\/(?:usr|etc|var|opt|Library|System|Applications|Users)\/[A-Za-z0-9._/-]{3,100})/g), 40),
    emails: uniq(s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g), 20),
    libraries: uniq(s.match(/(?:lib[A-Za-z0-9_+.-]{2,40}\.(?:so|dylib)(?:\.\d+)*|[A-Za-z0-9_-]{2,40}\.dll|@rpath\/[A-Za-z0-9_.+-]+)/gi), 60),
  };
}

export async function inspectBinary(name: string, b: Uint8Array, o: { strings?: boolean } = {}): Promise<BinaryInfo> {
  const kind = sniffKind(b);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const info: BinaryInfo = { kind, format: kind, architectures: [], notes: [], sha256: await sha256(b), bytes: b.byteLength };
  if (kind === "macho") {
    const be = dv.getUint32(0, false) === 0xfeedface || dv.getUint32(0, false) === 0xfeedfacf;
    const le = !be;
    const cpu = dv.getUint32(4, le), type = dv.getUint32(12, le), ncmds = dv.getUint32(16, le);
    info.format = "Mach-O"; info.architectures = [MACHO_CPU[cpu] ?? `cpu ${cpu}`]; info.fileType = MACHO_FILETYPE[type] ?? `type ${type}`; info.bits = (dv.getUint32(0, false) === 0xfeedfacf || dv.getUint32(0, false) === 0xcffaedfe) ? 64 : 32;
    // walk load commands for dylibs, UUID, min OS, code signature
    let off = info.bits === 64 ? 32 : 28; const dylibs: string[] = []; let signed = false; let encrypted = false; let minOS = ""; let uuid = "";
    for (let i = 0; i < Math.min(ncmds, 500) && off + 8 <= b.length; i++) {
      const cmd = dv.getUint32(off, le), size = dv.getUint32(off + 4, le);
      if (size < 8) break;
      if ([0xc, 0x80000018, 0x8, 0x1f].includes(cmd) || cmd === 0xd) { const nameOff = dv.getUint32(off + 8, le); if (cmd === 0xc || cmd === 0x80000018 || cmd === 0x1f) dylibs.push(Buffer.from(b.subarray(off + nameOff, off + size)).toString("utf8").replace(/\0.*$/, "")); }
      if (cmd === 0x1d) signed = true;
      if (cmd === 0x2c || cmd === 0x21) encrypted = dv.getUint32(off + 16, le) !== 0 || encrypted;
      if (cmd === 0x1b) uuid = [...b.subarray(off + 8, off + 24)].map((x) => x.toString(16).padStart(2, "0")).join("");
      if (cmd === 0x32 || cmd === 0x24) { const v = dv.getUint32(off + 12, le); minOS = `${v >> 16}.${(v >> 8) & 255}.${v & 255}`; }
      off += size;
    }
    info.extra = { dylibs, codeSignaturePresent: signed, encrypted, uuid, minOS };
    if (encrypted) info.notes.push("Binary is FairPlay-encrypted; its code cannot be statically analysed without decryption.");
  } else if (kind === "macho-universal") {
    const n = dv.getUint32(4, false); info.format = "Mach-O universal (fat)";
    for (let i = 0; i < Math.min(n, 8); i++) { const cpu = dv.getUint32(8 + i * 20, false); info.architectures.push(MACHO_CPU[cpu] ?? `cpu ${cpu}`); }
    info.extra = { slices: n };
  } else if (kind === "elf") {
    const le = b[5] === 1; info.format = "ELF"; info.bits = b[4] === 2 ? 64 : 32; info.architectures = [ELF_MACHINE[dv.getUint16(18, le)] ?? `machine ${dv.getUint16(18, le)}`]; info.fileType = ELF_TYPE[dv.getUint16(16, le)];
    const shnum = info.bits === 64 ? dv.getUint16(60, le) : dv.getUint16(48, le); info.sections = shnum;
  } else if (kind === "pe") {
    const peOff = dv.getUint32(0x3c, true);
    if (peOff + 24 < b.length && dv.getUint32(peOff, true) === 0x4550) {
      info.format = "PE (Windows)"; const machine = dv.getUint16(peOff + 4, true); info.architectures = [PE_MACHINE[machine] ?? `machine 0x${machine.toString(16)}`]; info.sections = dv.getUint16(peOff + 6, true);
      const ch = dv.getUint16(peOff + 22, true); info.fileType = ch & 0x2000 ? "DLL" : "executable";
      const optMagic = dv.getUint16(peOff + 24, true); info.bits = optMagic === 0x20b ? 64 : 32;
      const ddOff = peOff + 24 + (optMagic === 0x20b ? 112 : 96);
      const clr = ddOff + 14 * 8 + 4 <= b.length ? dv.getUint32(ddOff + 14 * 8, true) : 0;
      if (clr) { info.kind = "dotnet"; info.format = "PE/CLI (.NET assembly)"; info.notes.push(".NET assembly: use REA `inspect-managed-members` for types, members and CIL."); }
      info.extra = { timestamp: new Date(dv.getUint32(peOff + 8, true) * 1000).toISOString() };
    }
  } else if (kind === "wasm") {
    info.format = "WebAssembly"; info.architectures = ["wasm32"]; const secs: Record<string, number> = {}; let off = 8; const names: Record<number, string> = { 0: "custom", 1: "type", 2: "import", 3: "function", 4: "table", 5: "memory", 6: "global", 7: "export", 8: "start", 9: "element", 10: "code", 11: "data", 12: "datacount" };
    const leb = () => { let r = 0, s = 0, bt; do { bt = b[off++]!; r |= (bt & 0x7f) << s; s += 7; } while (bt & 0x80); return r >>> 0; };
    const imports: string[] = [], exports: string[] = [];
    while (off < b.length) { const id = b[off++]!; const len = leb(); const end = off + len; secs[names[id] ?? `id${id}`] = (secs[names[id] ?? `id${id}`] ?? 0) + 1;
      if (id === 2 || id === 7) { let p = off; const cnt = (() => { const o2 = off; const v = leb(); const used = off - o2; off = o2; return { v, used }; })(); p = off + cnt.used; const rd = () => { let r = 0, s = 0, bt; do { bt = b[p++]!; r |= (bt & 0x7f) << s; s += 7; } while (bt & 0x80); return r >>> 0; };
        try { for (let i = 0; i < Math.min(cnt.v, 500); i++) { if (id === 2) { const ml = rd(); const mod = Buffer.from(b.subarray(p, p + ml)).toString(); p += ml; const nl = rd(); const nm = Buffer.from(b.subarray(p, p + nl)).toString(); p += nl; const kind = b[p++]!; if (kind === 0) rd(); else if (kind === 1) { p++; const fl = rd(); rd(); if (fl & 1) rd(); } else if (kind === 2) { const fl = rd(); rd(); if (fl & 1) rd(); } else if (kind === 3) p += 2; imports.push(`${mod}.${nm}`); } else { const nl = rd(); exports.push(Buffer.from(b.subarray(p, p + nl)).toString()); p += nl; p++; rd(); } } } catch { /* truncated section */ } }
      off = end; }
    info.sections = Object.values(secs).reduce((a, c) => a + c, 0); info.extra = { sections: secs, imports: imports.slice(0, 100), exports: exports.slice(0, 100), version: dv.getUint32(4, true) };
  } else if (kind === "dmg") { info.format = "Apple Disk Image"; info.notes.push("DMG contents can be read only on macOS (hdiutil). Drag the extracted .app instead, or use the desktop app on a Mac."); }
  if (o.strings !== false && ["macho", "macho-universal", "elf", "pe", "dotnet"].includes(info.kind)) info.strings = extractStrings(b);
  if (info.kind === "unknown") info.notes.push(`Unrecognised format for “${name}”.`);
  return info;
}

/* ---------------- ASAR ---------------- */

export interface AsarEntry { path: string; size: number; offset: number; unpacked?: boolean }
export function parseAsar(b: Uint8Array): { entries: AsarEntry[]; dataStart: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const headerSize = dv.getUint32(12, true);
  const json = JSON.parse(Buffer.from(b.subarray(16, 16 + headerSize)).toString("utf8"));
  const dataStart = 8 + dv.getUint32(4, true);
  const entries: AsarEntry[] = [];
  const walk = (node: any, prefix: string) => { for (const [n, v] of Object.entries<any>(node.files ?? {})) { const p = prefix ? `${prefix}/${n}` : n; if (v.files) walk(v, p); else if (v.link === undefined) entries.push({ path: p, size: v.size, offset: Number(v.offset ?? 0), unpacked: !!v.unpacked }); } };
  walk(json, "");
  return { entries, dataStart };
}
export function readAsarFiles(b: Uint8Array, o: { maxFileBytes?: number; maxFiles?: number; maxTotal?: number } = {}): { files: InputFile[]; skipped: string[] } {
  const { entries, dataStart } = parseAsar(b);
  const files: InputFile[] = []; const skipped: string[] = []; let total = 0;
  for (const e of entries) {
    if (e.unpacked) { skipped.push(`${e.path} (unpacked; lives next to the .asar)`); continue; }
    if (e.size > (o.maxFileBytes ?? 8_000_000) || files.length >= (o.maxFiles ?? 20_000) || total + e.size > (o.maxTotal ?? 300_000_000)) { skipped.push(`${e.path} (limit)`); continue; }
    if (!/^[^\0]+$/.test(e.path) || e.path.split("/").includes("..")) { skipped.push(`${e.path} (unsafe path)`); continue; }
    const start = dataStart + e.offset; if (start + e.size > b.length) { skipped.push(`${e.path} (truncated)`); continue; }
    total += e.size; files.push({ path: e.path, data: b.slice(start, start + e.size), provenance: "recovered", origin: "app.asar" });
  }
  return { files, skipped };
}

/* ---------------- plist (XML only; binary plists need plutil/REA) ---------------- */

export function parseXmlPlist(xml: string): Record<string, unknown> | null {
  if (!/<plist/.test(xml)) return null;
  let i = xml.indexOf("<dict>"); if (i < 0) return null;
  const tok = /<(\/?)(dict|array|key|string|integer|real|true|false|date|data)\s*\/?>|([^<]+)/g; tok.lastIndex = i + 6;
  const parse = (kind: "dict" | "array"): any => {
    const out: any = kind === "dict" ? {} : []; let key: string | null = null; let m: RegExpExecArray | null;
    while ((m = tok.exec(xml))) {
      const [full, close, tag, text] = m;
      if (text !== undefined && !tag) continue;
      if (close && (tag === "dict" || tag === "array")) return out;
      if (close) continue;
      let val: any; let isVal = true;
      if (tag === "key") { const e = xml.indexOf("</key>", tok.lastIndex); key = xml.slice(tok.lastIndex, e).replace(/&amp;/g, "&"); tok.lastIndex = e + 6; isVal = false; }
      else if (tag === "dict" || tag === "array") val = parse(tag);
      else if (tag === "true") val = true; else if (tag === "false") val = false;
      else { const e = xml.indexOf(`</${tag}>`, tok.lastIndex); const raw = xml.slice(tok.lastIndex, e); tok.lastIndex = e + tag!.length + 3; val = tag === "integer" ? Number(raw) : tag === "real" ? Number(raw) : raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); void full; }
      if (isVal) { if (kind === "dict" && key !== null) { out[key] = val; key = null; } else if (kind === "array") out.push(val); }
    }
    return out;
  };
  return parse("dict");
}

/* ---------------- ZIP-based packages ---------------- */

export interface PackageReport {
  kind: ArtifactKind; name: string; sha256: string; bytes: number; summary: string[]; details: Record<string, unknown>;
  files: InputFile[]; // text sources recovered for source analysis (e.g. app.asar JS)
  limitations: string[]; recommendations: string[];
}

export async function inspectZipPackage(name: string, b: Uint8Array): Promise<PackageReport> {
  const { entries, skipped } = readZip(b, { maxTotalBytes: 400_000_000, maxEntryBytes: 60_000_000 });
  const names = entries.map((e) => e.path);
  const has = (re: RegExp) => names.some((n) => re.test(n));
  let kind: ArtifactKind = "zip";
  if (has(/^AndroidManifest\.xml$/)) kind = "apk"; else if (has(/^Payload\/[^/]+\.app\//)) kind = "ipa"; else if (has(/^META-INF\/MANIFEST\.MF$/)) kind = "jar"; else if (/\.crx$/i.test(name) || has(/^manifest\.json$/)) kind = "crx";
  const summary: string[] = []; const details: Record<string, unknown> = { entries: names.length };
  const limitations = skipped.length ? [`${skipped.length} entr${skipped.length === 1 ? "y was" : "ies were"} skipped by safety limits`] : [];
  const files: InputFile[] = []; const recommendations: string[] = [];
  const text = (n: string) => { const e = entries.find((x) => x.path === n); return e ? new TextDecoder().decode(e.data) : null; };
  if (kind === "apk") {
    const dex = names.filter((n) => /^classes\d*\.dex$/.test(n)); const abis = [...new Set(names.filter((n) => /^lib\/[^/]+\//.test(n)).map((n) => n.split("/")[1]))];
    summary.push(`Android package: ${dex.length} dex file(s), native ABIs: ${abis.join(", ") || "none"}`); details.dex = dex; details.abis = abis; details.hasResourcesArsc = has(/^resources\.arsc$/);
    limitations.push("AndroidManifest.xml is binary XML; decode it with REA (`decode-android-resources`, needs apktool) or JADX."); recommendations.push("Run REA inspect-android-package / JADX for classes and permissions.");
  } else if (kind === "ipa") {
    const app = names.find((n) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(n)); details.app = app?.split("/")[1];
    const raw = app ? entries.find((e) => e.path === app)!.data : null;
    if (raw && String.fromCharCode(...raw.subarray(0, 6)) === "bplist") limitations.push("Info.plist is a binary plist; decode with `plutil -p` (macOS) or REA `inspect-plist`.");
    else if (raw) { const pl = parseXmlPlist(new TextDecoder().decode(raw)); if (pl) { details.bundleId = pl.CFBundleIdentifier; details.version = pl.CFBundleShortVersionString; summary.push(`iOS app ${pl.CFBundleName ?? ""} ${pl.CFBundleIdentifier ?? ""} ${pl.CFBundleShortVersionString ?? ""}`.trim()); } }
    limitations.push("App Store IPAs are FairPlay-encrypted; the main binary cannot be analysed unless it is decrypted.");
  } else if (kind === "jar") { const mf = text("META-INF/MANIFEST.MF"); const main = mf?.match(/Main-Class:\s*(\S+)/)?.[1]; summary.push(`JAR: ${names.filter((n) => n.endsWith(".class")).length} class file(s)${main ? `, Main-Class ${main}` : ""}`); details.mainClass = main; recommendations.push("Decompile classes with JADX or CFR (not bundled)."); }
  else if (kind === "crx") { const mf = text("manifest.json"); try { const m = JSON.parse(mf ?? "{}"); summary.push(`Browser extension “${m.name}” v${m.version} (manifest v${m.manifest_version}); permissions: ${[...(m.permissions ?? []), ...(m.host_permissions ?? [])].join(", ") || "none"}`); details.manifest = m; } catch { /* invalid */ } }
  else summary.push(`ZIP archive with ${names.length} entries`);
  // recover readable sources
  let total = 0;
  for (const e of entries) { if (!/\.(?:[cm]?[jt]sx?|json|html|css|xml|yml|yaml|toml|md|txt|plist|properties|py|rb|php|sh|swift|kt|java)$/i.test(e.path) || e.bytes > 3_000_000 || total > 100_000_000) continue; total += e.bytes; files.push({ path: e.path, data: e.data, provenance: "recovered", origin: name }); }
  // nested ASAR
  const asars = entries.filter((e) => /\.asar$/.test(e.path) && sniffKind(e.data) === "asar");
  for (const a of asars) { const r = readAsarFiles(a.data); files.push(...r.files.map((f) => ({ ...f, path: `${a.path}/${f.path}` }))); summary.push(`Electron ASAR ${a.path}: ${r.files.length} file(s)`); }
  return { kind, name, sha256: await sha256(b), bytes: b.byteLength, summary, details, files, limitations, recommendations };
}

/* ---------------- .app bundles / directories ---------------- */

async function walkDir(dir: string, max = 5000): Promise<string[]> {
  const out: string[] = [];
  async function w(d: string, depth: number) { if (depth > 8 || out.length >= max) return; for (const it of await fs.readdir(d, { withFileTypes: true })) { if (it.isSymbolicLink()) continue; const full = path.join(d, it.name); out.push(path.relative(dir, full).split(path.sep).join("/") + (it.isDirectory() ? "/" : "")); if (it.isDirectory()) await w(full, depth + 1); } }
  await w(dir, 0); return out;
}

export async function inspectAppBundle(appPath: string): Promise<PackageReport> {
  const tree = await walkDir(appPath);
  const summary: string[] = []; const details: Record<string, unknown> = {}; const limitations: string[] = []; const recommendations: string[] = []; const files: InputFile[] = [];
  const info = path.join(appPath, "Contents", "Info.plist");
  let plist: Record<string, any> | null = null;
  try {
    const buf = await fs.readFile(info);
    if (buf.subarray(0, 6).toString() === "bplist") {
      const pl = which("plutil");
      if (pl) { const r = await exec(pl, ["-convert", "xml1", "-o", "-", info], { timeoutMs: 8000 }); plist = parseXmlPlist(r.stdout); } else limitations.push("Info.plist is a binary plist and plutil is unavailable on this OS; use the desktop app on macOS or REA.");
    } else plist = parseXmlPlist(buf.toString("utf8"));
  } catch { limitations.push("No Contents/Info.plist found; this may not be a macOS app bundle."); }
  if (plist) {
    details.info = { name: plist.CFBundleName ?? plist.CFBundleDisplayName, identifier: plist.CFBundleIdentifier, version: plist.CFBundleShortVersionString, build: plist.CFBundleVersion, executable: plist.CFBundleExecutable, minimumSystemVersion: plist.LSMinimumSystemVersion, urlTypes: plist.CFBundleURLTypes, usageDescriptions: Object.keys(plist).filter((k) => /UsageDescription$/.test(k)) };
    summary.push(`${plist.CFBundleName ?? path.basename(appPath)} ${plist.CFBundleShortVersionString ?? ""} (${plist.CFBundleIdentifier ?? "?"})`);
  }
  const frameworks = tree.filter((t) => /^Contents\/Frameworks\/[^/]+\/$/.test(t)).map((t) => t.split("/")[2]!.replace(/\.framework$/, ""));
  details.frameworks = frameworks;
  const stack: string[] = [];
  if (frameworks.some((f) => /Electron/.test(f))) stack.push("Electron"); if (frameworks.some((f) => /Sparkle/.test(f))) stack.push("Sparkle updater"); if (tree.some((t) => /libtauri|tauri/i.test(t))) stack.push("Tauri");
  if (tree.some((t) => /QtCore/.test(t))) stack.push("Qt"); if (frameworks.some((f) => /Flutter/.test(f))) stack.push("Flutter"); if (frameworks.some((f) => /Chromium Embedded|CEF/i.test(f))) stack.push("CEF"); if (tree.some((t) => /\.nib\/|\.storyboardc\//.test(t))) stack.push("AppKit/Interface Builder");
  if (stack.length) summary.push(`Detected: ${stack.join(", ")}`); details.stack = stack;
  const exeName = (plist?.CFBundleExecutable as string) ?? tree.find((t) => /^Contents\/MacOS\/[^/]+$/.test(t))?.split("/")[2];
  if (exeName) { const exe = path.join(appPath, "Contents", "MacOS", exeName); try { const fh = await fs.open(exe, "r"); const buf = Buffer.alloc(Math.min(8_000_000, (await fh.stat()).size)); await fh.read(buf, 0, buf.length, 0); await fh.close(); const bi = await inspectBinary(exeName, buf); details.executable = { ...bi, strings: bi.strings && { urls: bi.strings.urls.slice(0, 30), libraries: bi.strings.libraries.slice(0, 30) } }; summary.push(`Executable ${exeName}: ${bi.format} ${bi.architectures.join("+")}${(bi.extra as any)?.codeSignaturePresent ? ", code-signed" : ""}`); } catch { limitations.push(`Could not read executable ${exeName}`); } }
  const cs = which("codesign");
  if (cs) { const r = await exec(cs, ["-d", "--entitlements", ":-", "--verbose=2", appPath], { timeoutMs: 15_000 }); if (r.stdout || r.stderr) details.codesign = { output: (r.stdout + r.stderr).split("\n").slice(0, 40).join("\n") }; } else limitations.push("Code signature and entitlements are only read on macOS (codesign).");
  const asar = tree.find((t) => /\/app\.asar$/.test(t));
  if (asar) { try { const buf = await fs.readFile(path.join(appPath, asar)); if (sniffKind(buf) === "asar") { const r = readAsarFiles(buf); files.push(...r.files); summary.push(`Electron app.asar: ${r.files.length} source file(s) recovered`); recommendations.push("Run REA `analyze-javascript-application` on the extracted app for modules, IPC and preload boundaries."); } } catch { limitations.push("app.asar could not be read"); } }
  details.tree = tree.slice(0, 500); details.treeCount = tree.length;
  recommendations.push("For deep native analysis use REA with Hopper, Ghidra or IDA (needs your own installation/licence).");
  return { kind: "app-bundle", name: path.basename(appPath), sha256: "", bytes: 0, summary, details, files, limitations, recommendations };
}

/** Entry point: any path → report (never executes anything). */
export async function inspectPath(p: string): Promise<PackageReport> {
  const st = await fs.stat(p);
  if (st.isDirectory()) return /\.app\/?$/.test(p) ? inspectAppBundle(p.replace(/\/$/, "")) : { kind: "directory", name: path.basename(p), sha256: "", bytes: 0, summary: [`Directory with ${(await walkDir(p, 2000)).length} entries; analyse it as a source folder`], details: {}, files: [], limitations: [], recommendations: ["Use Analyze → Folder for source analysis."] };
  if (st.size > 1_500_000_000) throw new Error("File is larger than 1.5 GB");
  const buf = new Uint8Array(await fs.readFile(p));
  const kind = sniffKind(buf);
  if (kind === "zip") return inspectZipPackage(path.basename(p), buf);
  if (kind === "asar") { const r = readAsarFiles(buf); return { kind, name: path.basename(p), sha256: await sha256(buf), bytes: buf.byteLength, summary: [`Electron ASAR archive: ${r.files.length} source file(s)`], details: { skipped: r.skipped.slice(0, 50) }, files: r.files, limitations: r.skipped.length ? [`${r.skipped.length} file(s) skipped`] : [], recommendations: ["Run REA analyze-javascript-application for the full application graph."] }; }
  const bi = await inspectBinary(path.basename(p), buf);
  return { kind: bi.kind, name: path.basename(p), sha256: bi.sha256, bytes: bi.bytes, summary: [`${bi.format}${bi.architectures.length ? ` · ${bi.architectures.join(", ")}` : ""}${bi.fileType ? ` · ${bi.fileType}` : ""}${bi.bits ? ` · ${bi.bits}-bit` : ""}`, ...bi.notes], details: { ...bi }, files: [], limitations: ["Static header/strings analysis only. Disassembly and decompilation need Hopper, Ghidra or IDA (via REA)."], recommendations: bi.kind === "dotnet" ? ["REA inspect-managed-members for types and CIL"] : ["REA `analyze` with a configured native provider for functions and pseudocode"] };
}
