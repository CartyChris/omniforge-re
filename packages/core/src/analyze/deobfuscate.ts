/**
 * Optional JavaScript deobfuscation / bundle unpacking stage. The engine is injected (it needs a sandbox and a parser that do not belong in
 * every build); this module decides WHICH scripts to try, turns results into reconstructed source files, and keeps the evidence honest:
 * output is a readable reconstruction — original identifiers and comments are gone — never "recovered" source.
 */
import type { SourceFile } from "../schema.js";
import { sha256 } from "../util/index.js";
import { redactForStorage } from "../util/redact.js";

export interface DeobfuscateOutput {
  ok: boolean; tool: string;
  /** Readable code for the whole script (also set when the script was a bundle that could not be split). */
  code?: string;
  /** Present when a bundle (webpack/browserify) was split into modules. */
  modules?: { path: string; code: string }[];
  unpacked: boolean; changed: boolean; notes: string[]; error?: string; ms?: number;
}
export interface Deobfuscator { deobfuscate(code: string, o?: { signal?: AbortSignal }): Promise<DeobfuscateOutput> }

const MAX_SCRIPTS = 8, MAX_BYTES = 1_500_000, MAX_STORED = 400_000;

/** Cheap, conservative signals that a script is minified-beyond-reading, obfuscated, or a bundle worth splitting. */
export function looksObfuscated(code: string): { yes: boolean; why: string } {
  if (code.length < 2_000) return { yes: false, why: "small" };
  if (/\b_0x[0-9a-f]{3,6}\b/.test(code) && (code.match(/\b_0x[0-9a-f]{3,6}\b/g)?.length ?? 0) > 20) return { yes: true, why: "hex-named identifiers (obfuscator.io style)" };
  if (/__webpack_require__|webpackChunk|webpackJsonp|parcelRequire|\(\s*function\s*\(\s*[a-z]\s*,\s*[a-z]\s*,\s*[a-z]\s*\)\s*\{\s*function\s+[a-z]\s*\(\s*[a-z]\s*,\s*[a-z]\s*\)\s*\{/.test(code)) return { yes: true, why: "module bundle" };
  const lines = code.split("\n"); const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  if (longest > 1_500 && code.length / lines.length > 400) return { yes: true, why: "minified (very long lines)" };
  return { yes: false, why: "readable" };
}

export interface DeobfuscationStats { attempted: number; ok: number; unpacked: number; failed: number; skipped: number; candidates: number }

const slug = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "script";
const dir = (url: string) => { try { const u = new URL(url); return `${u.hostname}/${slug(u.pathname.split("/").filter(Boolean).pop() ?? "index").replace(/\.m?js$/i, "")}`; } catch { return slug(url); } };

/** Run the engine over the retained scripts (first-party first) and return reconstructed files. Never throws: failures are counted and described. */
export async function deobfuscateScripts(scripts: Map<string, string>, d: Deobfuscator, o: { firstParty: (url: string) => boolean; signal?: AbortSignal }): Promise<{ files: SourceFile[]; stats: DeobfuscationStats; results: { url: string; why: string; out: DeobfuscateOutput; paths: string[] }[] }> {
  const files: SourceFile[] = []; const results: { url: string; why: string; out: DeobfuscateOutput; paths: string[] }[] = [];
  const stats: DeobfuscationStats = { attempted: 0, ok: 0, unpacked: 0, failed: 0, skipped: 0, candidates: 0 };
  const cands = [...scripts.entries()].map(([url, code]) => ({ url, code, sig: looksObfuscated(code) })).filter((c) => c.sig.yes);
  stats.candidates = cands.length;
  cands.sort((a, b) => Number(o.firstParty(b.url)) - Number(o.firstParty(a.url)) || b.code.length - a.code.length);
  for (const c of cands) {
    if (o.signal?.aborted) break;
    if (stats.attempted >= MAX_SCRIPTS || c.code.length > MAX_BYTES || !o.firstParty(c.url)) { stats.skipped++; continue; }
    stats.attempted++;
    let out: DeobfuscateOutput;
    try { out = await d.deobfuscate(c.code, { signal: o.signal }); } catch (e) { out = { ok: false, tool: "unknown", unpacked: false, changed: false, notes: [], error: (e as Error).message }; }
    const paths: string[] = [];
    if (!out.ok || (!out.code && !out.modules?.length)) { stats.failed++; results.push({ url: c.url, why: c.sig.why, out, paths }); continue; }
    stats.ok++; if (out.unpacked) stats.unpacked++;
    const base = `reconstructed/${dir(c.url)}`;
    const items = out.modules?.length ? out.modules.map((m) => ({ path: `${base}/${m.path.replace(/\\/g, "/").split("/").filter((p) => p && p !== "." && p !== "..").join("/") || "module.js"}`, code: m.code })) : [{ path: `${base}.js`, code: out.code! }];
    for (const it of items) {
      const shown = it.code.slice(0, MAX_STORED); const stored = redactForStorage(it.path, shown);
      files.push({ path: it.path, language: "JavaScript", bytes: it.code.length, lines: it.code.split("\n").length, hash: await sha256(it.code), provenance: "reconstructed", origin: `${c.url} [${out.tool}: ${c.sig.why}${out.unpacked ? ", bundle split" : ""}]`, content: stored.text, truncated: it.code.length > MAX_STORED, ...(stored.kinds.length ? { redacted: stored.kinds } : {}) });
      paths.push(it.path);
    }
    results.push({ url: c.url, why: c.sig.why, out, paths });
  }
  return { files, stats, results };
}
