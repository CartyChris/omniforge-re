/** Per-language structure walkers. They read node types/fields of the VS Code tree-sitter grammars; each is covered by a fixture test. */
import type { Node } from "web-tree-sitter";
import { joinRoutePath, type CodeRoute, type CodeSymbol, type FileStructure, type SymbolKind } from "@omniforge/core";

export const EXT_LANG: Record<string, string> = { py: "python", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", go: "go", java: "java", rs: "rust", cs: "c-sharp" };
export const langOf = (p: string) => EXT_LANG[p.split(".").pop()?.toLowerCase() ?? ""];
const LABEL: Record<string, string> = { python: "Python", javascript: "JavaScript", typescript: "TypeScript", tsx: "TypeScript", go: "Go", java: "Java", rust: "Rust", "c-sharp": "C#" };

/** Text of a string-literal node without quotes/prefixes; null when it contains interpolation (the value is not static). */
export function strVal(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (/^(?:template_string|interpolated_string|f_string)/.test(n.type) || /\$\{|\{\{|\\\{/.test(n.type)) return null;
  const t = n.text;
  if (n.type === "template_string" && t.includes("${")) return null;
  if (n.type === "string" && /^[fF][rR]?["']/.test(t)) return null; // python f-string
  const m = t.match(/^[rRbBuU]*("""|'''|"|'|`|@")([\s\S]*?)\1$/); return m ? m[2]! : null;
}
const named = (n: Node) => n.namedChildren;
const field = (n: Node, f: string) => n.childForFieldName(f);
const kids = (n: Node, ...types: string[]) => named(n).filter((c) => types.includes(c.type));
const line = (n: Node) => n.startPosition.row + 1;
const VERBS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

class Collector {
  symbols: CodeSymbol[] = []; imports: string[] = []; routes: (CodeRoute & { col?: number })[] = [];
  constructor(readonly file: string, readonly language: string) {}
  sym(name: string | undefined, kind: SymbolKind, n: Node, container?: string) { if (name) this.symbols.push({ name, kind, file: this.file, line: line(n), language: this.language, ...(container ? { container } : {}) }); }
  imp(s: string | null | undefined) { if (s && !this.imports.includes(s)) this.imports.push(s); }
  route(method: string, path: string | null, n: Node, framework: string, handler?: string) { if (path !== null) this.routes.push({ method: method.toUpperCase(), path, file: this.file, line: line(n), col: n.startPosition.column, framework, ...(handler ? { handler } : {}) }); }
  done(): FileStructure { return { path: this.file, language: this.language, symbols: this.symbols, imports: this.imports, routes: this.routes.sort((a, b) => a.line - b.line || (a.col ?? 0) - (b.col ?? 0)).map(({ col: _c, ...r }) => r) }; }
}

function walk(n: Node, f: (n: Node) => boolean | void) { if (f(n) === false) return; for (const c of n.namedChildren) walk(c, f); }

/* ---------------------------------- Python ---------------------------------- */
function python(root: Node, c: Collector) {
  const py = /(?:^|\/)urls\.py$/.test(c.file);
  walk(root, (n) => {
    switch (n.type) {
      case "import_statement": for (const d of kids(n, "dotted_name", "aliased_import")) c.imp((d.type === "aliased_import" ? field(d, "name") : d)?.text); break;
      case "import_from_statement": c.imp(field(n, "module_name")?.text); break;
      case "class_definition": { const nm = field(n, "name")?.text; c.sym(nm, "class", n); break; }
      case "function_definition": { const inClass = n.parent?.parent?.type === "class_definition" || n.parent?.type === "class_definition"; const cls = inClass ? field((n.parent!.type === "class_definition" ? n.parent! : n.parent!.parent!), "name")?.text : undefined; c.sym(field(n, "name")?.text, inClass ? "method" : "function", n, cls); break; }
      case "decorated_definition": {
        const fn = kids(n, "function_definition", "class_definition")[0]; const handler = fn ? field(fn, "name")?.text : undefined;
        for (const d of kids(n, "decorator")) {
          const call = named(d)[0]; if (call?.type !== "call") continue;
          const fnode = field(call, "function"); if (fnode?.type !== "attribute") continue;
          const verb = field(fnode, "attribute")?.text?.toLowerCase(); const args = field(call, "arguments"); const p = strVal(args && named(args)[0]);
          if (!verb || p === null || !p.startsWith("/")) continue;
          if (["get", "post", "put", "delete", "patch", "head", "options"].includes(verb)) c.route(verb, p, d, "FastAPI/Flask", handler);
          else if (verb === "route" || verb === "api_route") {
            const methods = args ? kids(args, "keyword_argument").filter((k) => field(k, "name")?.text === "methods").flatMap((k) => walkStrings(field(k, "value")!)) : [];
            for (const m of methods.length ? methods : ["GET"]) c.route(m, p, d, "Flask", handler);
          } else if (verb === "websocket") c.route("GET", p, d, "FastAPI websocket", handler);
        }
        break;
      }
      case "call": if (py) { const fn = field(n, "function"); if (fn?.type === "identifier" && ["path", "re_path", "url"].includes(fn.text)) { const a = field(n, "arguments"); const p = strVal(a && named(a)[0]); if (p !== null) c.route("ANY", p.startsWith("/") ? p : "/" + p.replace(/^\^/, ""), n, "Django", undefined); } } break;
    }
  });
}
function walkStrings(n: Node): string[] { const out: string[] = []; walk(n, (x) => { if (x.type === "string") { const v = strVal(x); if (v) out.push(v.toUpperCase()); return false; } }); return out; }

/* ------------------------------ JavaScript / TypeScript ------------------------------ */
const NOT_SERVERS = new Set(["axios", "http", "https", "request", "client", "supertest", "superagent", "cy", "ky", "got", "$http", "fetch", "page", "browser", "map", "cache", "headers", "params", "searchparams", "form", "formdata", "storage", "localstorage", "sessionstorage", "process", "env", "config", "settings"]);
function js(root: Node, c: Collector) {
  walk(root, (n) => {
    switch (n.type) {
      case "import_statement": c.imp(strVal(field(n, "source"))); break;
      case "export_statement": { const s = field(n, "source"); if (s) c.imp(strVal(s)); break; }
      case "class_declaration": case "abstract_class_declaration": c.sym(field(n, "name")?.text, "class", n); break;
      case "interface_declaration": c.sym(field(n, "name")?.text, "interface", n); break;
      case "enum_declaration": c.sym(field(n, "name")?.text, "enum", n); break;
      case "type_alias_declaration": c.sym(field(n, "name")?.text, "type", n); break;
      case "function_declaration": case "generator_function_declaration": c.sym(field(n, "name")?.text, "function", n); break;
      case "method_definition": { const cls = n.parent?.parent; c.sym(field(n, "name")?.text, "method", n, cls ? field(cls, "name")?.text : undefined); break; }
      case "variable_declarator": { const v = field(n, "value"); if (v && ["arrow_function", "function_expression", "function"].includes(v.type) && field(n, "name")?.type === "identifier") c.sym(field(n, "name")!.text, "function", n); break; }
      case "call_expression": {
        const fn = field(n, "function"); const args = field(n, "arguments");
        if (fn?.type === "identifier" && fn.text === "require") c.imp(strVal(args && named(args)[0]));
        if (fn?.type === "member_expression" && args) {
          const verb = field(fn, "property")?.text?.toUpperCase(); const obj = field(fn, "object");
          if (verb && (VERBS.has(verb) || verb === "ALL") && !(obj?.type === "identifier" && NOT_SERVERS.has(obj.text.toLowerCase()))) {
            const a = named(args); const p = strVal(a[0]);
            // a server route registers a handler (function/identifier/call); a client call passes data (object/array) or nothing
            if (p !== null && p.startsWith("/") && a.length >= 2 && !["object", "array", "string", "number", "template_string"].includes(a[a.length - 1]!.type)) c.route(verb === "ALL" ? "ANY" : verb, p, n, "Express/Koa/Fastify-style", a[a.length - 1]!.type === "identifier" ? a[a.length - 1]!.text : undefined);
          }
        }
        break;
      }
    }
  });
}

/* ---------------------------------- Go ---------------------------------- */
const GO_VERBS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "ANY", "HANDLE", "HANDLEFUNC", "METHOD"]);
function go(root: Node, c: Collector) {
  walk(root, (n) => {
    switch (n.type) {
      case "import_spec": c.imp(strVal(field(n, "path") ?? named(n).find((x) => x.type === "interpreted_string_literal" || x.type === "raw_string_literal"))); break;
      case "function_declaration": c.sym(field(n, "name")?.text, "function", n); break;
      case "method_declaration": { const recv = field(n, "receiver"); const t = recv?.text.match(/\*?\s*([A-Za-z_]\w*)\s*\)?$/)?.[1]; c.sym(field(n, "name")?.text, "method", n, t); break; }
      case "type_spec": { const t = field(n, "type"); c.sym(field(n, "name")?.text, t?.type === "struct_type" ? "struct" : t?.type === "interface_type" ? "interface" : "type", n); break; }
      case "call_expression": {
        const fn = field(n, "function"); const args = field(n, "arguments");
        if (fn?.type === "selector_expression" && args) {
          const verb = field(fn, "field")?.text?.toUpperCase(); const a = named(args);
          if (verb && GO_VERBS.has(verb) && a.length >= 2) {
            let p = strVal(a[0]); let method = verb === "HANDLE" || verb === "HANDLEFUNC" || verb === "ANY" ? "ANY" : verb;
            const m = p?.match(/^([A-Z]+)\s+(\/.*)$/); if (m && VERBS.has(m[1]!)) { method = m[1]!; p = m[2]!; }
            if (p !== null && p.startsWith("/")) c.route(method, p, n, "Go net/http, gin, echo, chi", a[a.length - 1]!.type === "identifier" ? a[a.length - 1]!.text : undefined);
          }
        }
        break;
      }
    }
  });
}

/* ---------------------------------- Java ---------------------------------- */
const SPRING: Record<string, string> = { GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", DeleteMapping: "DELETE", PatchMapping: "PATCH", RequestMapping: "ANY" };
function annotationPaths(a: Node): string[] {
  const args = field(a, "arguments"); if (!args) return []; const out: string[] = [];
  for (const x of named(args)) {
    if (x.type === "string_literal") { const v = strVal(x); if (v !== null) out.push(v); }
    else if (x.type === "element_value_pair" && ["value", "path"].includes(field(x, "key")?.text ?? "")) { const v = field(x, "value"); if (v) walk(v, (y) => { if (y.type === "string_literal") { const s = strVal(y); if (s !== null) out.push(s); } }); }
    else if (x.type === "element_value_array_initializer") walk(x, (y) => { if (y.type === "string_literal") { const s = strVal(y); if (s !== null) out.push(s); } });
  }
  return out;
}
const annots = (decl: Node) => (kids(decl, "modifiers")[0] ? named(kids(decl, "modifiers")[0]!).filter((m) => m.type === "annotation" || m.type === "marker_annotation") : []);
function java(root: Node, c: Collector) {
  const classPrefix = (cls: Node | null) => { if (!cls) return undefined; const a = annots(cls).find((x) => field(x, "name")?.text === "RequestMapping"); return a ? annotationPaths(a)[0] : undefined; };
  walk(root, (n) => {
    switch (n.type) {
      case "import_declaration": c.imp(named(n).map((x) => x.text).join(".").replace(/\.\*$/, "")); break;
      case "class_declaration": case "record_declaration": c.sym(field(n, "name")?.text, "class", n); break;
      case "interface_declaration": case "annotation_type_declaration": c.sym(field(n, "name")?.text, "interface", n); break;
      case "enum_declaration": c.sym(field(n, "name")?.text, "enum", n); break;
      case "method_declaration": {
        let cls: Node | null = n.parent; while (cls && !["class_declaration", "interface_declaration", "record_declaration", "enum_declaration"].includes(cls.type)) cls = cls.parent;
        c.sym(field(n, "name")?.text, "method", n, cls ? field(cls, "name")?.text : undefined);
        for (const a of annots(n)) {
          const nm = field(a, "name")?.text ?? ""; const base = SPRING[nm]; if (!base) continue;
          let method = base;
          if (nm === "RequestMapping") { const pair = named(field(a, "arguments") ?? a).find((x) => x.type === "element_value_pair" && field(x, "key")?.text === "method"); const mv = pair && field(pair, "value")?.text.match(/([A-Z]+)\s*$/)?.[1]; if (mv && VERBS.has(mv)) method = mv; }
          const paths = annotationPaths(a); const prefix = classPrefix(cls);
          for (const p of paths.length ? paths : [""]) c.route(method, joinRoutePath(prefix, p), a, "Spring MVC", field(n, "name")?.text);
        }
        break;
      }
    }
  });
}

/* ---------------------------------- Rust ---------------------------------- */
function rust(root: Node, c: Collector) {
  walk(root, (n) => {
    switch (n.type) {
      case "use_declaration": c.imp(named(n)[0]?.text); break;
      case "struct_item": c.sym(field(n, "name")?.text, "struct", n); break;
      case "enum_item": c.sym(field(n, "name")?.text, "enum", n); break;
      case "trait_item": c.sym(field(n, "name")?.text, "trait", n); break;
      case "function_item": { const impl = n.parent?.parent?.type === "impl_item" ? n.parent.parent : null; c.sym(field(n, "name")?.text, impl ? "method" : "function", n, impl ? field(impl, "type")?.text : undefined); break; }
      case "attribute_item": {
        const attr = named(n)[0]; const id = named(attr!)[0]?.text; const tt = attr && kids(attr, "token_tree")[0];
        if (id && ["get", "post", "put", "delete", "patch", "head", "options"].includes(id) && tt) { const s = named(tt).find((x) => x.type === "string_literal"); const sib = n.nextNamedSibling; c.route(id, strVal(s) , n, "Actix/Rocket", sib?.type === "function_item" ? field(sib, "name")?.text : undefined); }
        break;
      }
      case "call_expression": {
        const fn = field(n, "function"); const args = field(n, "arguments");
        if (fn?.type === "field_expression" && field(fn, "field")?.text === "route" && args) {
          const a = named(args); const p = strVal(a[0]); const rest = a[1]?.text ?? "";
          if (p !== null && p.startsWith("/")) { const ms = [...rest.matchAll(/\b(get|post|put|delete|patch|head|options)\s*\(/g)].map((m) => m[1]!); for (const m of ms.length ? [...new Set(ms)] : ["any"]) c.route(m, p, a[0]!, "axum", rest.match(new RegExp(`\\b${m}\\s*\\(\\s*([A-Za-z_][\\w:]*)\\s*[,)]`))?.[1]); }
        }
        break;
      }
    }
  });
}

/* ---------------------------------- C# ---------------------------------- */
const CS_ATTR: Record<string, string> = { HttpGet: "GET", HttpPost: "POST", HttpPut: "PUT", HttpDelete: "DELETE", HttpPatch: "PATCH", HttpHead: "HEAD", HttpOptions: "OPTIONS", Route: "ANY" };
const csAttrs = (decl: Node) => kids(decl, "attribute_list").flatMap((l) => kids(l, "attribute"));
const csAttrPath = (a: Node) => { const al = kids(a, "attribute_argument_list")[0]; const first = al && kids(al, "attribute_argument")[0]; return strVal(first && named(first).find((x) => x.type === "string_literal")); };
function csharp(root: Node, c: Collector) {
  walk(root, (n) => {
    switch (n.type) {
      case "using_directive": c.imp(named(n).find((x) => x.type === "qualified_name" || x.type === "identifier")?.text); break;
      case "class_declaration": case "record_declaration": case "struct_declaration": c.sym(field(n, "name")?.text, n.type === "struct_declaration" ? "struct" : "class", n); break;
      case "interface_declaration": c.sym(field(n, "name")?.text, "interface", n); break;
      case "enum_declaration": c.sym(field(n, "name")?.text, "enum", n); break;
      case "method_declaration": {
        const cls = n.parent?.parent; const cname = cls ? field(cls, "name")?.text : undefined; c.sym(field(n, "name")?.text, "method", n, cname);
        const rootAttr = cls ? csAttrs(cls).find((a) => field(a, "name")?.text === "Route") : undefined;
        const prefix = (rootAttr ? csAttrPath(rootAttr) : null)?.replace(/\[controller\]/gi, (cname ?? "").replace(/Controller$/, "").toLowerCase()) ?? undefined;
        for (const a of csAttrs(n)) {
          const nm = field(a, "name")?.text ?? ""; const m = CS_ATTR[nm]; if (!m) continue;
          const p = csAttrPath(a) ?? ""; c.route(m, joinRoutePath(prefix, p, { absoluteOverrides: true }), a, "ASP.NET Core", field(n, "name")?.text);
        }
        break;
      }
      case "invocation_expression": {
        const fn = field(n, "function") ?? named(n)[0]; const args = field(n, "arguments") ?? kids(n, "argument_list")[0];
        if (fn?.type === "member_access_expression" && args) { const nm = field(fn, "name")?.text ?? ""; const m = nm.match(/^Map(Get|Post|Put|Delete|Patch)$/)?.[1]; const first = kids(args, "argument")[0]; const p = strVal(first && named(first).find((x) => x.type === "string_literal")); if (m && p !== null) c.route(m, p.startsWith("/") ? p : "/" + p, n, "ASP.NET minimal API"); }
        break;
      }
    }
  });
}

const WALKERS: Record<string, (root: Node, c: Collector) => void> = { python, javascript: js, typescript: js, tsx: js, go, java, rust, "c-sharp": csharp };
export const languageLabel = (g: string) => LABEL[g] ?? g;
export function extractFile(root: Node, path: string, lang: string): FileStructure { const c = new Collector(path, languageLabel(lang)); WALKERS[lang]!(root, c); return c.done(); }
