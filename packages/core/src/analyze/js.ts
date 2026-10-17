/**
 * Static JavaScript analysis with a real AST (acorn).
 * Large or unparsable bundles fall back to lexical scanning, and the result
 * says which method produced it.
 */
import { parse, type Node } from "acorn";
import { simple as walkSimple } from "acorn-walk";
import { envVarNames } from "../util/redact.js";

export interface JsAnalysis {
  method: "ast" | "lexical";
  parseError?: string;
  bytes: number;
  imports: string[];
  dynamicImports: string[];
  exports: string[];
  functions: string[];
  components: string[]; // Capitalised functions/classes that render (createElement/jsx calls)
  classes: string[];
  routes: string[];
  endpoints: { url: string; method?: string; via: string }[];
  events: string[];
  storageKeys: string[];
  envVars: string[];
  sourceMappingURL?: string;
  chunks: number; // webpack / turbopack chunk module count where visible
  strings: number;
  minified: boolean;
}

const ROUTE_RE = /^\/(?!\/)[a-z0-9\-_.~%:[\]{}*$]*(?:\/[a-z0-9\-_.~%:[\]{}*$]+)*\/?$/i;
const ASSET_EXT = /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|map|json|wasm|mp4|webm|mp3|txt|xml)$/i;

function looksLikeRoute(s: string): boolean {
  if (s.length < 2 || s.length > 120 || !ROUTE_RE.test(s)) return false;
  if (ASSET_EXT.test(s)) return false;
  if (/^\/(?:_next|static|assets|_nuxt|_app|node_modules|@)/.test(s)) return false;
  if (/^\/[a-z]$/.test(s)) return false; // regex-ish fragments
  return /[a-z]{2,}/i.test(s);
}

function looksLikeEndpoint(s: string): boolean {
  if (s.length > 300) return false;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(s)) return !ASSET_EXT.test(s.split("?")[0]!);
  return /^\/(?:api|graphql|v\d+|rest|rpc|trpc|ws|socket|auth|oauth)(?:[/?#]|$)/i.test(s);
}

export function analyzeJs(code: string, opts: { maxAstBytes?: number } = {}): JsAnalysis {
  const bytes = code.length;
  const lines = code.split("\n");
  const avgLine = bytes / Math.max(1, lines.length);
  const res: JsAnalysis = {
    method: "ast",
    bytes,
    imports: [],
    dynamicImports: [],
    exports: [],
    functions: [],
    components: [],
    classes: [],
    routes: [],
    endpoints: [],
    events: [],
    storageKeys: [],
    envVars: envVarNames(code),
    chunks: 0,
    strings: 0,
    minified: avgLine > 300,
  };
  const smu = code.match(/\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/m);
  if (smu) res.sourceMappingURL = smu[1];
  const chunkMatches = code.match(/["']?\d{2,7}["']?\s*:\s*(?:function\s*\(\s*\w*\s*,\s*\w*\s*,\s*\w*\s*\)|\(\s*\w*\s*,\s*\w*\s*,\s*\w*\s*\)\s*=>)/g);
  res.chunks = chunkMatches?.length ?? 0;

  const imports = new Set<string>();
  const dyn = new Set<string>();
  const exps = new Set<string>();
  const fns = new Set<string>();
  const comps = new Set<string>();
  const classes = new Set<string>();
  const routes = new Set<string>();
  const endpoints = new Map<string, { url: string; method?: string; via: string }>();
  const events = new Set<string>();
  const storage = new Set<string>();

  const addString = (s: string) => {
    res.strings++;
    if (looksLikeRoute(s)) routes.add(s.replace(/\/$/, "") || "/");
    if (looksLikeEndpoint(s) && !endpoints.has(s)) endpoints.set(s, { url: s, via: "string-literal" });
  };

  if (bytes <= (opts.maxAstBytes ?? 4_000_000)) {
    let ast: Node | null = null;
    for (const sourceType of ["module", "script"] as const) {
      try {
        ast = parse(code, { ecmaVersion: "latest", sourceType, allowHashBang: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, allowImportExportEverywhere: true });
        break;
      } catch (e) {
        res.parseError = (e as Error).message;
      }
    }
    if (ast) {
      res.parseError = undefined;
      const calleeName = (n: any): string => {
        if (!n) return "";
        if (n.type === "Identifier") return n.name;
        if (n.type === "MemberExpression") return `${calleeName(n.object)}.${n.property?.name ?? n.property?.value ?? "?"}`;
        return "";
      };
      const strArg = (n: any): string | undefined =>
        n?.type === "Literal" && typeof n.value === "string" ? n.value : n?.type === "TemplateLiteral" && n.quasis.length === 1 ? n.quasis[0].value.cooked : undefined;
      const rendersJsx = (body: any): boolean => {
        let found = false;
        try {
          walkSimple(body, {
            CallExpression(c: any) {
              const name = calleeName(c.callee);
              if (/(?:^|\.)(?:createElement|jsxs?|jsxDEV|_jsxs?|h)$/.test(name)) found = true;
            },
          });
        } catch {
          /* ignore */
        }
        return found;
      };
      walkSimple(ast, {
        ImportDeclaration(n: any) {
          imports.add(n.source.value);
        },
        ExportNamedDeclaration(n: any) {
          if (n.declaration?.id?.name) exps.add(n.declaration.id.name);
          for (const d of n.declaration?.declarations ?? []) if (d.id?.name) exps.add(d.id.name);
          for (const s of n.specifiers ?? []) exps.add(s.exported?.name ?? s.exported?.value);
          if (n.source?.value) imports.add(n.source.value);
        },
        ExportDefaultDeclaration() {
          exps.add("default");
        },
        ExportAllDeclaration(n: any) {
          if (n.source?.value) imports.add(n.source.value);
        },
        ImportExpression(n: any) {
          const s = strArg(n.source);
          if (s) dyn.add(s);
        },
        FunctionDeclaration(n: any) {
          if (!n.id?.name) return;
          fns.add(n.id.name);
          if (/^[A-Z][A-Za-z0-9]{2,}$/.test(n.id.name) && rendersJsx(n.body)) comps.add(n.id.name);
        },
        VariableDeclarator(n: any) {
          const name = n.id?.name;
          if (!name || !n.init) return;
          if (n.init.type === "ArrowFunctionExpression" || n.init.type === "FunctionExpression") {
            fns.add(name);
            if (/^[A-Z][A-Za-z0-9]{2,}$/.test(name) && rendersJsx(n.init.body)) comps.add(name);
          }
        },
        ClassDeclaration(n: any) {
          if (n.id?.name) classes.add(n.id.name);
        },
        Literal(n: any) {
          if (typeof n.value === "string") addString(n.value);
        },
        TemplateLiteral(n: any) {
          for (const q of n.quasis) if (q.value.cooked) addString(q.value.cooked);
          if (n.quasis.length > 1) {
            const joined = n.quasis.map((q: any) => q.value.cooked ?? "").join(":param");
            if (looksLikeEndpoint(joined)) endpoints.set(joined, { url: joined, via: "template-literal" });
          }
        },
        CallExpression(n: any) {
          const name = calleeName(n.callee);
          const first = strArg(n.arguments[0]);
          if (name === "require" && first) imports.add(first);
          if (/(?:^|\.)(?:fetch|get|post|put|patch|delete|request|ajax)$/.test(name) && first && (looksLikeEndpoint(first) || first.startsWith("/"))) {
            const method = /\.(get|post|put|patch|delete)$/.exec(name)?.[1]?.toUpperCase();
            let m = method;
            const init = n.arguments[1];
            if (!m && init?.type === "ObjectExpression") {
              const mp = init.properties.find((p: any) => (p.key?.name ?? p.key?.value) === "method");
              const mv = strArg(mp?.value);
              if (mv) m = mv.toUpperCase();
            }
            endpoints.set(first, { url: first, method: m ?? (name.endsWith("fetch") ? "GET" : undefined), via: name });
          }
          if (/addEventListener$/.test(name) && first) events.add(first);
          if (/(?:local|session)Storage\.(?:getItem|setItem|removeItem)$/.test(name) && first) storage.add(first);
          if (/^(?:new )?WebSocket$/.test(name) && first) endpoints.set(first, { url: first, via: "WebSocket" });
        },
        NewExpression(n: any) {
          const name = calleeName(n.callee);
          const first = strArg(n.arguments[0]);
          if ((name === "WebSocket" || name === "EventSource") && first) endpoints.set(first, { url: first, via: name });
        },
        Property(n: any) {
          // JSX props compiled to objects: onClick, onSubmit … reveal handlers
          const k = n.key?.name ?? n.key?.value;
          if (typeof k === "string" && /^on[A-Z][a-zA-Z]+$/.test(k) && (n.value?.type?.includes("Function") || n.value?.type === "Identifier")) {
            events.add(k.slice(2).toLowerCase());
          }
          // router configs: { path: "/x", ... }
          if (k === "path") {
            const v = strArg(n.value);
            if (v && (looksLikeRoute(v) || /^[a-z][\w-]*(?:\/:\w+)*$/i.test(v))) routes.add(v.startsWith("/") ? v : `/${v}`);
          }
        },
      });
    } else res.method = "lexical";
  } else {
    res.method = "lexical";
    res.parseError = `Skipped AST: ${bytes} bytes exceeds limit`;
  }

  if (res.method === "lexical") {
    for (const m of code.matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)) imports.add(m[1]!);
    for (const m of code.matchAll(/["'`](\/[^"'`\s]{1,120}|https?:\/\/[^"'`\s]{4,300})["'`]/g)) addString(m[1]!);
    for (const m of code.matchAll(/addEventListener\(\s*["']([a-z]+)["']/g)) events.add(m[1]!);
    for (const m of code.matchAll(/(?:local|session)Storage\.(?:getItem|setItem)\(\s*["']([^"']+)["']/g)) storage.add(m[1]!);
  }

  const cap = <T>(s: Iterable<T>, n: number) => [...s].slice(0, n);
  res.imports = cap(imports, 500);
  res.dynamicImports = cap(dyn, 300);
  res.exports = cap(exps, 300);
  res.functions = cap(fns, 400);
  res.components = cap(comps, 300);
  res.classes = cap(classes, 200);
  res.routes = cap(routes, 300).sort();
  res.endpoints = cap(endpoints.values(), 300);
  res.events = cap(events, 100).sort();
  res.storageKeys = cap(storage, 100);
  return res;
}

/** Light-touch beautifier for minified JS: line-breaks after ; { } — readable, not semantic. */
export function prettyJs(code: string, max = 400_000): string {
  const src = code.length > max ? code.slice(0, max) : code;
  let out = "";
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    out += ch;
    if (inStr) {
      if (ch === "\\") {
        out += src[++i] ?? "";
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") inStr = ch;
    else if (ch === "{") {
      depth++;
      out += "\n" + "  ".repeat(depth);
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      out += "\n" + "  ".repeat(depth);
    } else if (ch === ";" && src[i + 1] !== "\n") out += "\n" + "  ".repeat(depth);
  }
  return out.replace(/\n\s*\n/g, "\n");
}
