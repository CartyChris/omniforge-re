/**
 * Multi-language code structure (symbols, imports, HTTP routes) from a real parser. The parser is injected by the host (it needs WASM
 * grammars): this module owns the contract and how results become investigation data. Everything extracted is read directly from source
 * text, so it is `recovered` evidence — but only what a static parse can see: routes built from variables, config or reflection are not found.
 */
import type { Endpoint, Evidence, SourceFile } from "../schema.js";

export type SymbolKind = "function" | "method" | "class" | "struct" | "interface" | "enum" | "trait" | "type";
export interface CodeSymbol { name: string; kind: SymbolKind; file: string; line: number; language: string; container?: string }
export interface CodeRoute { method: string; path: string; file: string; line: number; framework: string; handler?: string }
export interface FileStructure { path: string; language: string; symbols: CodeSymbol[]; imports: string[]; routes: CodeRoute[] }
export interface StructureResult { files: FileStructure[]; parsed: number; unsupported: number; failed: { path: string; error: string }[]; languages: string[] }
export interface StructureExtractor { extract(files: { path: string; content: string }[], o?: { signal?: AbortSignal }): Promise<StructureResult> }

export const MAX_SYMBOLS = 5000;

/** Join a controller prefix and a method path the way web frameworks do. ASP.NET lets an absolute method path override the prefix; Spring and others concatenate. */
export function joinRoutePath(prefix: string | undefined, path: string, o: { absoluteOverrides?: boolean } = {}): string {
  const norm = (s: string) => { let r = "/" + s.replace(/^\/+/, ""); r = r.replace(/\/{2,}/g, "/"); if (r.length > 1) r = r.replace(/\/$/, ""); return r; };
  if (!prefix) return norm(path);
  if (o.absoluteOverrides && /^~?\//.test(path)) return norm(path.replace(/^~/, ""));
  if (!path) return norm(prefix);
  return norm(`${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
}

export function routeEndpoints(r: StructureResult, evidence: (e: Omit<Evidence, "id" | "timestamp">) => string): Endpoint[] {
  const seen = new Set<string>(); const out: Endpoint[] = [];
  for (const f of r.files) for (const rt of f.routes) {
    const key = `${rt.method} ${rt.path}`; if (seen.has(key)) continue; seen.add(key);
    out.push({ url: rt.path, method: rt.method === "ANY" ? undefined : rt.method, kind: /ws|socket/i.test(rt.framework) ? "websocket" : "rest", foundIn: `${rt.file}:${rt.line}`, evidence: evidence({ kind: "recovered", method: "tree-sitter", source: `${rt.file}:${rt.line}`, confidence: 0.9, summary: `${rt.method} ${rt.path} defined in ${rt.file}:${rt.line} (${rt.framework})` }) });
  }
  return out;
}

export function capSymbols(r: StructureResult): CodeSymbol[] {
  return r.files.flatMap((f) => f.symbols).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line).slice(0, MAX_SYMBOLS);
}

/** Files worth sending to a parser: have content, are not huge, and are source (the host decides which languages it supports). */
export const structureCandidates = (files: SourceFile[] | { path: string; content?: string }[]) => (files as { path: string; content?: string }[]).filter((f) => f.content !== undefined && f.content.length <= 400_000).map((f) => ({ path: f.path, content: f.content! }));
