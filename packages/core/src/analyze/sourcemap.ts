/**
 * Source map handling. When a map ships `sourcesContent`, the original files
 * are RECOVERED verbatim. When only `sources` paths are present, the module
 * tree is recorded as structure only — never presented as recovered code.
 */
import type { SourceFile } from "../schema.js";
import { sha256 } from "../util/index.js";
import { safeEntryPath } from "./archive.js";

export interface RawSourceMap {
  version?: number;
  sources?: string[];
  sourcesContent?: (string | null)[];
  sourceRoot?: string;
  names?: string[];
  file?: string;
  sections?: { offset: { line: number; column: number }; map: RawSourceMap }[];
}

export interface SourceMapResult {
  ok: boolean;
  error?: string;
  totalSources: number;
  recovered: number;
  /** sources listed but shipped without content (structure only) */
  withoutContent: number;
  files: SourceFile[];
  moduleTree: string[]; // every first-party source path, normalised
  vendored: number; // node_modules / bundler runtime sources that were skipped
}

const MAX_RECOVERED_BYTES = 500_000;

function langFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
    js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
    vue: "Vue", svelte: "Svelte", css: "CSS", scss: "SCSS", sass: "Sass", less: "Less",
    json: "JSON", html: "HTML", md: "Markdown", py: "Python", rs: "Rust", go: "Go", astro: "Astro",
  };
  return map[ext] ?? "Text";
}

/** Normalise bundler-specific schemes and neutralise traversal. */
export function cleanSourcePath(src: string, root?: string): string {
  let p = src;
  if (root && !p.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(p)) p = `${root.replace(/\/$/, "")}/${p}`;
  p = p.replace(/^webpack(?:-internal)?:\/\/(?:_N_E\/|[^/]*\/)?/i, "");
  p = p.replace(/^(?:ng|turbopack|rollup|vite|file|app):\/{0,3}/i, "");
  p = p.replace(/\?[\w=&.-]*$/i, "").replace(/^\.?\//, "");
  // Drop any ".." segments rather than letting them escape a future write root.
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== "." && s !== "..");
  return parts.join("/") || "unknown";
}

const VENDORED = /(?:^|\/)node_modules\/|webpack\/(?:bootstrap|runtime)|\(webpack\)|^\[turbopack\]|^\(webpack-internal\)|\/\.pnpm\//;

/** Decode an inline `//# sourceMappingURL=data:application/json;base64,…` map. */
export function decodeInlineSourceMap(url: string): string | null {
  const m = url.match(/^data:application\/json(?:;charset=[\w-]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  try {
    if (m[1]) {
      const bin = atob(m[2]!);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
}

function flatten(map: RawSourceMap, depth = 0): { sources: string[]; contents: (string | null | undefined)[]; root?: string }[] {
  if (map.sections && depth < 3) return map.sections.flatMap((s) => flatten(s.map, depth + 1));
  return [{ sources: map.sources ?? [], contents: map.sourcesContent ?? [], root: map.sourceRoot }];
}

export async function parseSourceMap(json: string, origin: string): Promise<SourceMapResult> {
  const empty = { totalSources: 0, recovered: 0, withoutContent: 0, files: [], moduleTree: [], vendored: 0 };
  let map: RawSourceMap;
  try {
    map = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}`, ...empty };
  }
  if (typeof map !== "object" || map === null || (!Array.isArray(map.sources) && !Array.isArray(map.sections))) {
    return { ok: false, error: "Not a source map (no `sources` or `sections`)", ...empty };
  }
  const files: SourceFile[] = [];
  const tree = new Set<string>();
  const seen = new Set<string>();
  let total = 0;
  let recovered = 0;
  let withoutContent = 0;
  let vendored = 0;
  for (const part of flatten(map)) {
    for (let i = 0; i < part.sources.length; i++) {
      const raw = part.sources[i];
      if (typeof raw !== "string") continue;
      total++;
      if (VENDORED.test(raw)) {
        vendored++;
        continue;
      }
      const path = cleanSourcePath(raw, part.root);
      tree.add(path);
      const content = part.contents[i];
      if (typeof content !== "string" || !content.length) {
        withoutContent++;
        continue;
      }
      if (seen.has(path)) continue;
      seen.add(path);
      recovered++;
      const truncated = content.length > MAX_RECOVERED_BYTES;
      files.push({
        path,
        language: langFor(path),
        bytes: content.length,
        lines: content.split("\n").length,
        hash: await sha256(content),
        provenance: "recovered",
        origin: `${origin} [sourcesContent #${i}]`,
        content: truncated ? content.slice(0, MAX_RECOVERED_BYTES) : content,
        truncated,
      });
    }
  }
  return { ok: true, totalSources: total, recovered, withoutContent, files, moduleTree: [...tree].sort(), vendored };
}

export { safeEntryPath };
