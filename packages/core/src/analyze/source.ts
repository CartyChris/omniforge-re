/**
 * Source tree analysis: content-aware language detection, manifests,
 * dependencies, build systems, entrypoints, env-var NAMES, database
 * definitions and an internal module graph.
 *
 * Works on in-memory file lists, so it behaves identically in the browser,
 * on Vercel, and in the desktop app (which feeds it files from disk).
 */
import type { Dependency, Graph, SourceFile } from "../schema.js";
import { dotenvNames, envVarNames, findSecretLikeValues } from "../util/redact.js";
import { sha256 } from "../util/index.js";
import { analyzeJs } from "./js.js";
import { parseLockfile, parseManifest, type ManifestResult } from "./deps.js";

const EXT_LANG: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", pyi: "Python", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", kts: "Kotlin",
  c: "C", h: "C/C++ header", cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", cs: "C#", swift: "Swift",
  m: "Objective-C", mm: "Objective-C++", rb: "Ruby", php: "PHP", scala: "Scala", dart: "Dart", lua: "Lua",
  sql: "SQL", sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell", r: "R", jl: "Julia", ex: "Elixir", exs: "Elixir",
  html: "HTML", htm: "HTML", vue: "Vue", svelte: "Svelte", astro: "Astro", css: "CSS", scss: "SCSS", sass: "Sass", less: "Less",
  json: "JSON", jsonc: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", xml: "XML", md: "Markdown", mdx: "MDX",
  graphql: "GraphQL", gql: "GraphQL", proto: "Protocol Buffers", prisma: "Prisma", tf: "Terraform",
  wasm: "WebAssembly", pdf: "PDF", svg: "SVG", ini: "INI", env: "dotenv", lock: "Lockfile", txt: "Text",
};
const NAME_LANG: Record<string, string> = {
  dockerfile: "Dockerfile", makefile: "Makefile", gemfile: "Ruby", rakefile: "Ruby", procfile: "Procfile",
  jenkinsfile: "Groovy", "cmakelists.txt": "CMake", ".gitignore": "gitignore", ".env": "dotenv",
};
const SHEBANG: [RegExp, string][] = [
  [/^#!.*\b(?:node|bun|deno)\b/, "JavaScript"], [/^#!.*\bpython[\d.]*\b/, "Python"], [/^#!.*\b(?:ba|z|da)?sh\b/, "Shell"],
  [/^#!.*\bruby\b/, "Ruby"], [/^#!.*\bperl\b/, "Perl"], [/^#!.*\bphp\b/, "PHP"],
];
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp[34]|mov|webm|wav|ogg|zip|gz|tgz|bz2|xz|7z|rar|jar|class|so|dylib|dll|exe|o|a|pyc|wasm|pdf|psd|sketch|fig|node|bin|dat|db|sqlite)$/i;

/** Magic-byte sniffing so classification does not depend only on extensions. */
export function sniffBinary(bytes: Uint8Array): string | null {
  const b = bytes;
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0x50, 0x4b, 0x03, 0x04)) return "zip";
  if (at(0, 0x1f, 0x8b)) return "gzip";
  if (at(0, 0x00, 0x61, 0x73, 0x6d)) return "wasm";
  if (at(0, 0x7f, 0x45, 0x4c, 0x46)) return "elf";
  if (at(0, 0x4d, 0x5a)) return "pe";
  if (at(0, 0xcf, 0xfa, 0xed, 0xfe) || at(0, 0xce, 0xfa, 0xed, 0xfe) || at(0, 0xca, 0xfe, 0xba, 0xbe)) return "mach-o";
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return "pdf";
  if (at(0, 0x53, 0x51, 0x4c, 0x69, 0x74, 0x65)) return "sqlite";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  if (at(0, 0x77, 0x4f, 0x46, 0x32)) return "woff2";
  let nul = 0;
  const n = Math.min(b.length, 4096);
  for (let i = 0; i < n; i++) if (b[i] === 0) nul++;
  return nul > 0 ? "binary" : null;
}

export function detectLanguage(path: string, head: string): string {
  const base = path.split("/").pop()!.toLowerCase();
  if (NAME_LANG[base]) return NAME_LANG[base]!;
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  if (EXT_LANG[ext]) return EXT_LANG[ext]!;
  const first = head.split("\n", 1)[0] ?? "";
  if (first.startsWith("#!")) for (const [re, lang] of SHEBANG) if (re.test(first)) return lang;
  const t = head.trimStart();
  if (/^<!doctype html|^<html[\s>]/i.test(t)) return "HTML";
  if (/^<\?xml/i.test(t)) return "XML";
  if (/^<\?php/.test(t)) return "PHP";
  if (/^[{[]\s*["{\]]/.test(t)) return "JSON";
  return ext ? ext.toUpperCase() : "Unknown";
}

/** Extract import specifiers for the languages we can read without a full parser. */
export function extractImports(lang: string, code: string): string[] {
  const out = new Set<string>();
  const add = (re: RegExp, g = 1) => {
    for (const m of code.matchAll(re)) if (m[g]) out.add(m[g]!);
  };
  switch (lang) {
    case "JavaScript":
    case "TypeScript":
    case "Vue":
    case "Svelte":
    case "Astro":
      add(/\bimport\s+(?:[^'"()]*?\s+from\s+)?["']([^"']+)["']/g);
      add(/\bexport\s+[^'"()]*?\s+from\s+["']([^"']+)["']/g);
      add(/\brequire\(\s*["']([^"']+)["']\s*\)/g);
      add(/\bimport\(\s*["']([^"']+)["']\s*\)/g);
      break;
    case "Python":
      add(/^\s*from\s+([\w.]+)\s+import\b/gm);
      add(/^\s*import\s+([\w.]+)/gm);
      break;
    case "Rust":
      add(/^\s*use\s+([\w:]+)/gm);
      add(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm);
      break;
    case "Go":
      add(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm);
      for (const block of code.matchAll(/import\s*\(([\s\S]*?)\)/g)) for (const m of block[1]!.matchAll(/"([^"]+)"/g)) out.add(m[1]!);
      break;
    case "Java":
    case "Kotlin":
    case "Scala":
      add(/^\s*import\s+(?:static\s+)?([\w.]+)/gm);
      break;
    case "Swift":
      add(/^\s*import\s+(\w+)/gm);
      break;
    case "C":
    case "C++":
    case "C/C++ header":
      add(/^\s*#\s*include\s+["<]([^">]+)[">]/gm);
      break;
    case "C#":
      add(/^\s*using\s+([\w.]+)\s*;/gm);
      break;
    case "PHP":
      add(/\b(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/g);
      add(/^\s*use\s+([\w\\]+)/gm);
      break;
    case "Ruby":
      add(/^\s*require(?:_relative)?\s+["']([^"']+)["']/gm);
      break;
    case "CSS":
    case "SCSS":
    case "Sass":
    case "Less":
      add(/@(?:import|use|forward)\s+(?:url\()?["']([^"']+)["']/g);
      break;
    case "HTML":
      add(/<script[^>]+src=["']([^"']+)["']/gi);
      add(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi);
      break;
  }
  return [...out];
}

const JS_RESOLVE_EXT = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".json", "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs"];

function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** Resolve a relative import to a file in the tree, or null when external/unresolvable. */
export function resolveInternal(fromPath: string, spec: string, known: Set<string>, lang: string): string | null {
  if (lang === "Python") {
    const rel = spec.startsWith(".");
    const dotted = spec.replace(/^\.+/, "").replace(/\./g, "/");
    const dir = fromPath.split("/").slice(0, -1).join("/");
    const candidates = rel ? [`${dir}/${dotted}.py`, `${dir}/${dotted}/__init__.py`] : [`${dotted}.py`, `${dotted}/__init__.py`, `src/${dotted}.py`];
    return candidates.map(normalizePath).find((c) => known.has(c)) ?? null;
  }
  if (lang === "Rust") {
    const dir = fromPath.split("/").slice(0, -1).join("/");
    return [`${dir}/${spec}.rs`, `${dir}/${spec}/mod.rs`].map(normalizePath).find((c) => known.has(c)) ?? null;
  }
  if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("@/") && !spec.startsWith("~/") && !spec.startsWith("#")) return null;
  const dir = fromPath.split("/").slice(0, -1).join("/");
  let base: string;
  if (spec.startsWith("@/") || spec.startsWith("~/")) base = normalizePath(`src/${spec.slice(2)}`);
  else if (spec.startsWith("/")) base = normalizePath(spec);
  else base = normalizePath(`${dir}/${spec}`);
  for (const ext of JS_RESOLVE_EXT) if (known.has(base + ext)) return base + ext;
  // TypeScript ESM style: ./x.js → ./x.ts
  const swapped = base.replace(/\.(m|c)?js$/, ".ts");
  if (swapped !== base && known.has(swapped)) return swapped;
  const swappedTsx = base.replace(/\.js$/, ".tsx");
  if (known.has(swappedTsx)) return swappedTsx;
  return null;
}

export interface InputFile {
  path: string;
  data: Uint8Array;
  origin?: string;
  provenance?: SourceFile["provenance"];
}

export interface SourceTreeAnalysis {
  files: SourceFile[];
  languages: { language: string; files: number; lines: number; bytes: number }[];
  manifests: { path: string; buildSystem?: string; name?: string; framework?: string; scripts?: Record<string, string> }[];
  dependencies: Dependency[];
  buildSystems: string[];
  frameworks: string[];
  entrypoints: string[];
  envVars: { name: string; files: string[] }[];
  databaseDefinitions: { path: string; kind: string; detail: string }[];
  secretFiles: { path: string; kinds: string[] }[]; // values are NEVER included
  routes: { route: string; file: string }[];
  endpoints: { url: string; method?: string; file: string }[];
  components: { name: string; file: string }[];
  graph: Graph;
  binaries: { path: string; kind: string; bytes: number }[];
  skipped: { path: string; reason: string }[];
  tree: { dirs: number; files: number; depth: number };
}

const MAX_TEXT_BYTES = 1_500_000;
const LOCKFILES = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/;

/** Conventional framework entrypoints & route files. */
function routeFromFile(path: string): string | null {
  let m = path.match(/^(?:src\/)?app\/(.*)\/page\.(?:tsx|jsx|ts|js|mdx)$/);
  if (m) return "/" + m[1]!.replace(/\([^)]+\)\/?/g, "").replace(/\/$/, "");
  if (/^(?:src\/)?app\/page\.(?:tsx|jsx|ts|js|mdx)$/.test(path)) return "/";
  m = path.match(/^(?:src\/)?pages\/(.*)\.(?:tsx|jsx|ts|js|vue|svelte|astro|mdx)$/);
  if (m && !/^_/.test(m[1]!.split("/").pop()!)) return "/" + m[1]!.replace(/\/?index$/, "");
  m = path.match(/^src\/routes\/(.*)\/\+page\.svelte$/);
  if (m) return "/" + m[1];
  if (path === "src/routes/+page.svelte") return "/";
  return null;
}

export async function analyzeSourceTree(inputs: InputFile[], opts: { includeContent?: boolean } = {}): Promise<SourceTreeAnalysis> {
  const includeContent = opts.includeContent ?? true;
  const known = new Set(inputs.map((i) => i.path));
  const files: SourceFile[] = [];
  const langAgg = new Map<string, { files: number; lines: number; bytes: number }>();
  const manifests: SourceTreeAnalysis["manifests"] = [];
  const deps: Dependency[] = [];
  const buildSystems = new Set<string>();
  const frameworks = new Set<string>();
  const entrypoints = new Set<string>();
  const envMap = new Map<string, Set<string>>();
  const dbDefs: SourceTreeAnalysis["databaseDefinitions"] = [];
  const secretFiles: SourceTreeAnalysis["secretFiles"] = [];
  const routes: SourceTreeAnalysis["routes"] = [];
  const endpoints: SourceTreeAnalysis["endpoints"] = [];
  const components: SourceTreeAnalysis["components"] = [];
  const binaries: SourceTreeAnalysis["binaries"] = [];
  const skipped: SourceTreeAnalysis["skipped"] = [];
  const graph: Graph = { nodes: [], edges: [] };
  const nodeIds = new Set<string>();
  const dirs = new Set<string>();
  let maxDepth = 0;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const imports = new Map<string, { lang: string; specs: string[] }>();

  const addNode = (id: string, type: Graph["nodes"][number]["type"], label: string, data?: Record<string, unknown>) => {
    if (nodeIds.has(id)) return;
    nodeIds.add(id);
    graph.nodes.push({ id, type, label, data });
  };

  for (const f of inputs) {
    const depth = f.path.split("/").length;
    maxDepth = Math.max(maxDepth, depth);
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    const sniff = sniffBinary(f.data);
    if (sniff || BINARY_EXT.test(f.path)) {
      binaries.push({ path: f.path, kind: sniff ?? "binary", bytes: f.data.byteLength });
      continue;
    }
    if (f.data.byteLength > MAX_TEXT_BYTES) {
      skipped.push({ path: f.path, reason: `larger than ${MAX_TEXT_BYTES} bytes; content not analysed` });
      continue;
    }
    const text = decoder.decode(f.data);
    const language = detectLanguage(f.path, text.slice(0, 600));
    const lines = text.length ? text.split("\n").length : 0;
    const agg = langAgg.get(language) ?? { files: 0, lines: 0, bytes: 0 };
    agg.files++;
    agg.lines += lines;
    agg.bytes += f.data.byteLength;
    langAgg.set(language, agg);

    files.push({
      path: f.path,
      language,
      bytes: f.data.byteLength,
      lines,
      hash: await sha256(f.data),
      provenance: f.provenance ?? "user",
      origin: f.origin ?? "upload",
      content: includeContent ? text : undefined,
    });
    addNode(`file:${f.path}`, "file", f.path.split("/").pop()!, { path: f.path, language });

    const base = f.path.split("/").pop()!.toLowerCase();
    const isLock = LOCKFILES.test(f.path);
    if (isLock) {
      const locked = parseLockfile(f.path, text);
      deps.push(...locked);
      if (locked.length) buildSystems.add(f.path.split("/").pop()!.replace(/\.(json|yaml|lock)$/, "") + " lockfile");
    } else {
      const mf: ManifestResult | null = parseManifest(f.path, text);
      if (mf) {
        manifests.push({ path: f.path, buildSystem: mf.buildSystem, name: mf.name, framework: mf.framework, scripts: mf.scripts });
        deps.push(...mf.dependencies.map((d) => ({ ...d, source: f.path })));
        if (mf.buildSystem) buildSystems.add(mf.buildSystem);
        if (mf.framework) frameworks.add(mf.framework);
        const dir = f.path.split("/").slice(0, -1).join("/");
        for (const e of mf.entrypoints) entrypoints.add(normalizePath(`${dir}/${e}`));
      }
    }
    if (/^(?:vite|next|nuxt|svelte|astro|webpack|rollup|tsup|esbuild|remix|tailwind|postcss|babel|jest|vitest|playwright)\.config\./.test(base)) buildSystems.add(base.split(".")[0]!);
    if (base === "dockerfile") buildSystems.add("Docker");
    if (base === "makefile") buildSystems.add("Make");
    if (base === "cmakelists.txt") buildSystems.add("CMake");
    if (base === "vercel.json") buildSystems.add("Vercel");
    if (base === "tauri.conf.json") frameworks.add("Tauri");
    if (/\.github\/workflows\/.+\.ya?ml$/.test(f.path)) buildSystems.add("GitHub Actions");

    // environment variable NAMES only
    const names = new Set<string>(envVarNames(text));
    if (/(^|\/)\.env(\.[\w.-]+)?$|\.env\.example$|\.env\.sample$/i.test(f.path)) for (const n of dotenvNames(text)) names.add(n);
    for (const n of names) {
      const set = envMap.get(n) ?? new Set();
      set.add(f.path);
      envMap.set(n, set);
    }
    // secrets: record that something secret-shaped exists in this file, never the value
    if (!/\.(md|mdx|txt|lock)$/.test(f.path) && !isLock) {
      const kinds = findSecretLikeValues(text.slice(0, 400_000));
      if (kinds.length) secretFiles.push({ path: f.path, kinds });
    }

    // database definitions
    if (language === "SQL") {
      const tables = [...text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?([\w.]+)["`]?/gi)].map((m) => m[1]!);
      dbDefs.push({ path: f.path, kind: "sql", detail: tables.length ? `tables: ${tables.slice(0, 20).join(", ")}` : "SQL file" });
    } else if (language === "Prisma") {
      const models = [...text.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]!);
      dbDefs.push({ path: f.path, kind: "prisma", detail: `models: ${models.join(", ")}` });
    } else if (/(?:^|\/)(?:drizzle|migrations?|alembic)\b/.test(f.path) && language !== "Markdown") {
      dbDefs.push({ path: f.path, kind: "migration", detail: "migration file" });
    }

    // route files by convention
    const r = routeFromFile(f.path);
    if (r !== null) {
      routes.push({ route: r || "/", file: f.path });
      entrypoints.add(f.path); // file-system routing: every page file is an entrypoint
    }
    if (/^(?:src\/)?app\/layout\.(?:tsx|jsx|ts|js)$/.test(f.path)) entrypoints.add(f.path);
    if (/(?:^|\/)(?:src\/)?(?:index|main|app|server|cli)\.(?:tsx?|jsx?|mjs|py|go|rs)$/.test(f.path) || /(?:^|\/)src\/main\.rs$|(?:^|\/)main\.go$|(?:^|\/)__main__\.py$|(?:^|\/)manage\.py$/.test(f.path)) entrypoints.add(f.path);

    // imports + JS-specific facts
    const specs = extractImports(language, text);
    imports.set(f.path, { lang: language, specs });
    if (language === "JavaScript" || language === "TypeScript") {
      const js = analyzeJs(text, { maxAstBytes: language === "TypeScript" ? 0 : 1_500_000 });
      for (const c of js.components) components.push({ name: c, file: f.path });
      for (const e of js.endpoints) endpoints.push({ url: e.url, method: e.method, file: f.path });
      if (language === "JavaScript") for (const rt of js.routes) routes.push({ route: rt, file: f.path });
    }
    if (language === "TypeScript" || language === "Vue" || language === "Svelte") {
      // TSX/Vue components that cannot be AST-parsed with acorn: lexical detection
      for (const m of text.matchAll(/(?:export\s+(?:default\s+)?)?(?:function|const)\s+([A-Z][A-Za-z0-9]{2,})\s*(?::[^=]+)?(?:=\s*(?:\([^)]*\)|[A-Za-z_]+)\s*(?::[^=]+)?=>|\()/g)) {
        if (/<[A-Za-z][^>]*>|jsx\(|createElement\(/.test(text)) components.push({ name: m[1]!, file: f.path });
      }
      for (const m of text.matchAll(/\b(?:fetch|axios\.(?:get|post|put|patch|delete))\(\s*["'`]([^"'`]+)["'`]/g)) endpoints.push({ url: m[1]!, file: f.path });
    }
  }

  // internal + external edges
  const externalSeen = new Set<string>();
  for (const [from, { lang, specs }] of imports) {
    for (const spec of specs) {
      const target = resolveInternal(from, spec, known, lang);
      if (target) {
        const id = `${from}->${target}`;
        graph.edges.push({ id, source: `file:${from}`, target: `file:${target}`, type: "imports" });
      } else if (!spec.startsWith(".") && !spec.startsWith("/")) {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split(/[/:.]/)[0]!;
        if (!pkg) continue;
        const nid = `module:${pkg}`;
        addNode(nid, "module", pkg);
        const eid = `${from}->${nid}`;
        if (!externalSeen.has(eid)) {
          externalSeen.add(eid);
          graph.edges.push({ id: eid, source: `file:${from}`, target: nid, type: "uses" });
        }
      }
    }
  }

  const uniqEntry = [...entrypoints].filter((e) => known.has(e));
  return {
    files,
    languages: [...langAgg.entries()].map(([language, v]) => ({ language, ...v })).sort((a, b) => b.lines - a.lines),
    manifests,
    dependencies: dedupeDeps(deps),
    buildSystems: [...buildSystems].sort(),
    frameworks: [...frameworks].sort(),
    entrypoints: uniqEntry.sort(),
    envVars: [...envMap.entries()].map(([name, set]) => ({ name, files: [...set].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
    databaseDefinitions: dbDefs,
    secretFiles,
    routes: dedupeBy(routes, (r) => r.route + r.file).sort((a, b) => a.route.localeCompare(b.route)),
    endpoints: dedupeBy(endpoints, (e) => e.url + (e.method ?? "") + e.file),
    components: dedupeBy(components, (c) => c.name + c.file),
    graph,
    binaries,
    skipped,
    tree: { dirs: dirs.size, files: inputs.length, depth: maxDepth },
  };
}

function dedupeDeps(d: Dependency[]): Dependency[] {
  return dedupeBy(d, (x) => `${x.ecosystem}:${x.name}:${x.version ?? ""}:${x.dev ? 1 : 0}:${x.source}`);
}
function dedupeBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    const k = key(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}
