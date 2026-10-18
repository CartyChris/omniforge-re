/**
 * Technical artifacts supplied by the user: OpenAPI/Swagger specs, GraphQL schemas, HAR captures, SBOMs
 * (CycloneDX / SPDX JSON) and application logs. Everything here is parsed deterministically; nothing is guessed.
 *
 * Privacy: HAR files routinely contain credentials. Header values for auth-like headers, cookies and sensitive
 * query parameters are dropped, and request/response BODIES are never kept — only sizes and content types.
 */
import { parse as parseYaml } from "yaml";
import type { Dependency, Endpoint, Evidence, Feature, Finding, Technology } from "../schema.js";
import { hashStr, now, uid } from "../util/index.js";
import { redactSecrets } from "../util/redact.js";
import type { InputFile } from "./source.js";

export type ArtifactKind = "openapi" | "graphql" | "har" | "sbom" | "log";

export interface ArtifactAnalysis {
  found: { path: string; kind: ArtifactKind; detail: string }[];
  endpoints: Endpoint[];
  dependencies: Dependency[];
  features: Feature[];
  findings: Finding[];
  evidence: Evidence[];
  technologies: Technology[];
  thirdParties: { host: string; kinds: string[]; count: number }[];
  notes: string[];
}

const dec = new TextDecoder("utf-8");
const SENSITIVE_QUERY = /^(?:access_?token|id_?token|refresh_?token|token|api_?key|apikey|key|secret|password|passwd|pwd|auth|authorization|session|sid|code|signature|sig|jwt)$/i;
const SENSITIVE_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = ""; u.password = "";
    for (const k of [...u.searchParams.keys()]) if (SENSITIVE_QUERY.test(k)) u.searchParams.set(k, "REDACTED");
    return u.toString();
  } catch { return redactSecrets(raw).text.slice(0, 300); }
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

function tryJson(text: string): any | undefined { try { return JSON.parse(text); } catch { return undefined; } }
function tryYaml(text: string): any | undefined { try { const v = parseYaml(text, { maxAliasCount: 50 }); return v && typeof v === "object" ? v : undefined; } catch { return undefined; } }

/** Cheap, content-based detection so a spec named `api.json` or `swagger.yml` or `export.txt` is still recognised. */
export function detectArtifact(path: string, text: string): ArtifactKind | null {
  const head = text.slice(0, 4000);
  if (/\.(?:graphql|gql)$/i.test(path) || /^\s*(?:extend\s+)?type\s+(?:Query|Mutation|Subscription)\b/m.test(head) || /\bschema\s*\{[^}]*\bquery\s*:/m.test(head)) return "graphql";
  if (/\.har$/i.test(path) || /"log"\s*:\s*\{[\s\S]{0,300}"entries"\s*:/.test(head)) return "har";
  if (/"bomFormat"\s*:\s*"CycloneDX"/.test(head) || /"spdxVersion"\s*:\s*"SPDX-/.test(head) || /(?:^|[\\/])(?:bom|sbom)[.\w-]*\.json$/i.test(path) && /"components"|"packages"/.test(text.slice(0, 20000))) return "sbom";
  if (/(?:^|\s|")(?:openapi|swagger)(?:"|\s)*:\s*"?\s*[23]\./.test(head) && /\bpaths\b/.test(text)) return "openapi";
  if (/\.log$/i.test(path) || (path.endsWith(".txt") && /^\S*\s*(?:\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d|\[\d{2}\/\w{3}\/\d{4}).*\b(?:ERROR|WARN|INFO|DEBUG|FATAL)\b/m.test(head))) return "log";
  return null;
}

type Ctx = { ev: (e: Omit<Evidence, "id" | "timestamp">) => string; out: ArtifactAnalysis };

/* ------------------------------ OpenAPI ------------------------------ */
function openApi(path: string, doc: any, c: Ctx) {
  const title = String(doc.info?.title ?? "API"); const version = String(doc.info?.version ?? "");
  const paths = doc.paths && typeof doc.paths === "object" ? doc.paths : {};
  const base = (Array.isArray(doc.servers) && doc.servers[0]?.url) || (doc.host ? `${(doc.schemes?.[0] ?? "https")}://${doc.host}${doc.basePath ?? ""}` : "");
  const rootEv = c.ev({ kind: "observed", method: "openapi", source: path, confidence: 1, summary: `OpenAPI ${doc.openapi ?? doc.swagger}: “${title}” ${version}, ${Object.keys(paths).length} path(s)` });
  const byTag = new Map<string, { ops: string[]; params: Set<string>; bodies: Set<string>; responses: Set<string>; errors: Set<string>; evidence: string[] }>();
  let ops = 0;
  for (const [p, item] of Object.entries<any>(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const m of METHODS) {
      const op = item[m]; if (!op || typeof op !== "object") continue;
      ops++;
      const label = `${m.toUpperCase()} ${p}`;
      const id = c.ev({ kind: "observed", method: "openapi", source: path, confidence: 1, summary: `${label}${op.summary ? ` — ${String(op.summary).slice(0, 100)}` : ""}`, related: [rootEv] });
      c.out.endpoints.push({ url: `${String(base).replace(/\/$/, "")}${p}`, method: m.toUpperCase(), kind: "rest", foundIn: path, evidence: id });
      const tags: string[] = Array.isArray(op.tags) && op.tags.length ? op.tags.map(String) : ["General"];
      for (const t of tags) {
        const g = byTag.get(t) ?? { ops: [], params: new Set(), bodies: new Set(), responses: new Set(), errors: new Set(), evidence: [] };
        g.ops.push(label); g.evidence.push(id);
        for (const prm of [...(item.parameters ?? []), ...(op.parameters ?? [])]) if (prm && typeof prm === "object" && prm.name) g.params.add(`${prm.in ?? "param"}:${prm.name}${prm.required ? " (required)" : ""}`);
        const rb = op.requestBody?.content ? Object.keys(op.requestBody.content) : []; for (const ct of rb) g.bodies.add(`${label} body ${ct}`);
        for (const [code, r] of Object.entries<any>(op.responses ?? {})) { const d = `${code}${r?.description ? ` ${String(r.description).slice(0, 50)}` : ""}`; (/^[45]/.test(code) || code === "default" ? g.errors : g.responses).add(`${label} → ${d}`); }
        byTag.set(t, g);
      }
    }
  }
  const schemes = Object.entries<any>(doc.components?.securitySchemes ?? doc.securityDefinitions ?? {}).map(([n, s]) => `${n} (${s?.type ?? "?"}${s?.scheme ? `/${s.scheme}` : ""})`);
  for (const [tag, g] of [...byTag].slice(0, 30)) {
    c.out.features.push({ id: `ft_${hashStr(`api:${path}:${tag}`).slice(0, 10)}`, name: `API: ${tag}`, category: "Documented API", description: `${g.ops.length} operation(s) in “${title}”: ${g.ops.slice(0, 4).join(", ")}${g.ops.length > 4 ? "…" : ""}`, pages: [], files: [path], evidence: g.evidence.slice(0, 8), confidence: 1, provenance: "observed",
      spec: { purpose: `Documented by the supplied specification (${title}${version ? ` ${version}` : ""}).`, inputs: [...g.params, ...g.bodies].slice(0, 20), outputs: [...g.responses].slice(0, 20), states: [], transitions: [], dependencies: schemes, errorStates: [...g.errors].slice(0, 20), accessibility: [], hypotheses: [] } });
  }
  c.out.found.push({ path, kind: "openapi", detail: `${ops} operation(s), ${byTag.size} tag group(s)${schemes.length ? `, security: ${schemes.join(", ")}` : ""}` });
  if (!schemes.length && ops) c.out.findings.push({ id: uid("fd"), area: "security", severity: "info", title: `${title}: no security schemes declared`, detail: "The specification declares no authentication. That may be intentional (public API) or an omission in the document.", evidence: [rootEv] });
  c.out.technologies.push({ name: `OpenAPI ${doc.openapi ?? doc.swagger}`, category: "API style", confidence: 1, evidence: [rootEv] });
}

/* ------------------------------ GraphQL SDL ------------------------------ */
function graphql(path: string, text: string, c: Ctx) {
  const clean = text.replace(/#.*$/gm, "").replace(/"""[\s\S]*?"""/g, "");
  const types: Record<string, string[]> = {};
  const re = /\b(?:extend\s+)?type\s+(Query|Mutation|Subscription)\b[^{]*\{([^}]*)\}/g; let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const fields = m[2]!.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/\s+/g, " "));
    // join multi-line argument lists
    const joined: string[] = []; let buf = "";
    for (const l of fields) { buf += (buf ? " " : "") + l; if ((buf.match(/\(/g) ?? []).length <= (buf.match(/\)/g) ?? []).length) { joined.push(buf); buf = ""; } }
    (types[m[1]!] ??= []).push(...joined);
  }
  const typeCount = (clean.match(/\b(?:type|input|enum|interface|union|scalar)\s+\w+/g) ?? []).length;
  const rootEv = c.ev({ kind: "observed", method: "graphql-sdl", source: path, confidence: 1, summary: `GraphQL schema: ${typeCount} type definition(s); ${Object.entries(types).map(([k, v]) => `${v.length} ${k}`).join(", ") || "no root operation types found"}` });
  let n = 0;
  for (const [root, fields] of Object.entries(types)) for (const f of fields) {
    const name = f.match(/^(\w+)/)?.[1]; if (!name) continue; n++;
    const id = c.ev({ kind: "observed", method: "graphql-sdl", source: path, confidence: 1, summary: `${root}.${f.slice(0, 140)}`, related: [rootEv] });
    c.out.endpoints.push({ url: `graphql://${root}.${name}`, method: root === "Query" ? "QUERY" : root === "Mutation" ? "MUTATION" : "SUBSCRIPTION", kind: "graphql", foundIn: path, evidence: id });
  }
  for (const [root, fields] of Object.entries(types)) {
    c.out.features.push({ id: `ft_${hashStr(`gql:${path}:${root}`).slice(0, 10)}`, name: `GraphQL ${root}s`, category: "Documented API", description: `${fields.length} ${root.toLowerCase()} field(s): ${fields.slice(0, 5).map((f) => f.match(/^\w+/)?.[0]).join(", ")}${fields.length > 5 ? "…" : ""}`, pages: [], files: [path], evidence: [rootEv], confidence: 1, provenance: "observed",
      spec: { purpose: `${root} operations declared by the supplied schema.`, inputs: fields.slice(0, 20), outputs: ["Types as declared in the schema"], states: [], transitions: [], dependencies: [], errorStates: ["GraphQL errors array (not described by SDL)"], accessibility: [], hypotheses: [] } });
  }
  c.out.found.push({ path, kind: "graphql", detail: `${typeCount} types, ${n} root field(s)` });
  c.out.technologies.push({ name: "GraphQL", category: "API style", confidence: 1, evidence: [rootEv] });
}

/* ------------------------------ HAR ------------------------------ */
const SERVER_TECH: [RegExp, string, string][] = [[/nginx/i, "nginx", "Web server"], [/apache/i, "Apache HTTP Server", "Web server"], [/cloudflare/i, "Cloudflare", "CDN"], [/vercel/i, "Vercel", "Hosting"], [/netlify/i, "Netlify", "Hosting"], [/amazons3|cloudfront/i, "AWS CloudFront/S3", "CDN"], [/express/i, "Express", "Web framework"], [/next\.js/i, "Next.js", "Web framework"], [/php/i, "PHP", "Language"], [/asp\.net/i, "ASP.NET", "Web framework"], [/gunicorn|uvicorn|werkzeug/i, "Python web server", "Web server"], [/envoy/i, "Envoy", "Proxy"], [/akamai/i, "Akamai", "CDN"], [/fastly/i, "Fastly", "CDN"]];
function har(path: string, doc: any, c: Ctx) {
  const entries: any[] = Array.isArray(doc?.log?.entries) ? doc.log.entries : [];
  const rootEv = c.ev({ kind: "observed", method: "har", source: path, confidence: 1, summary: `HAR capture (${doc?.log?.creator?.name ?? "unknown tool"}): ${entries.length} request(s); credentials, cookies and bodies were not retained` });
  const hosts = new Map<string, { kinds: Set<string>; n: number }>(); const seen = new Set<string>();
  let errors4 = 0, errors5 = 0, slow = 0, insecure = 0, mixed = 0, noSecureCookie = 0; const techSeen = new Map<string, Technology>();
  const pageHost = (() => { try { return new URL(entries[0]?.request?.url ?? "").host; } catch { return ""; } })();
  for (const e of entries.slice(0, 5000)) {
    const req = e?.request ?? {}, res = e?.response ?? {};
    let u: URL; try { u = new URL(String(req.url)); } catch { continue; }
    const method = String(req.method ?? "GET").toUpperCase(); const status = Number(res.status) || 0;
    const ct = String(res.content?.mimeType ?? "").split(";")[0] ?? "";
    const h = hosts.get(u.host) ?? { kinds: new Set<string>(), n: 0 }; h.n++; h.kinds.add(ct.includes("javascript") ? "script" : ct.includes("css") ? "style" : ct.includes("json") ? "api" : ct.startsWith("image/") ? "image" : ct.startsWith("font/") || ct.includes("font") ? "font" : "request"); hosts.set(u.host, h);
    if (status >= 500) errors5++; else if (status >= 400) errors4++;
    if ((Number(e.time) || 0) > 3000) slow++;
    if (u.protocol === "http:" && !/^(?:localhost|127\.|\[::1\])/.test(u.hostname)) { insecure++; if (pageHost && entries[0]?.request?.url?.startsWith("https:")) mixed++; }
    const isApi = ct.includes("json") || /\/(?:api|graphql|v\d+)\b/i.test(u.pathname) || ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    if (isApi && !seen.has(`${method} ${u.host}${u.pathname}`)) {
      seen.add(`${method} ${u.host}${u.pathname}`);
      const id = c.ev({ kind: "observed", method: "har", source: path, confidence: 1, summary: `${method} ${redactUrl(u.origin + u.pathname)} → ${status} ${ct}`.trim(), related: [rootEv] });
      c.out.endpoints.push({ url: redactUrl(u.origin + u.pathname), method, kind: /graphql/i.test(u.pathname) ? "graphql" : u.protocol.startsWith("ws") ? "websocket" : "rest", foundIn: path, evidence: id });
    }
    for (const hd of res.headers ?? []) {
      const name = String(hd?.name ?? "").toLowerCase(); const val = String(hd?.value ?? "");
      if (SENSITIVE_HEADER.test(name)) { if (name === "set-cookie" && /;\s*secure/i.test(val) === false && u.protocol === "https:") noSecureCookie++; continue; }
      if (name === "server" || name === "x-powered-by" || name === "via" || name === "x-served-by") for (const [re, tn, cat] of SERVER_TECH) if (re.test(val) && !techSeen.has(tn)) { const id = c.ev({ kind: "observed", method: "har-header", source: path, confidence: 0.9, summary: `${hd.name}: ${val.slice(0, 80)} → ${tn}`, related: [rootEv] }); techSeen.set(tn, { name: tn, category: cat, confidence: 0.9, evidence: [id] }); }
    }
  }
  for (const [host, v] of hosts) if (host !== pageHost) c.out.thirdParties.push({ host, kinds: [...v.kinds], count: v.n });
  c.out.technologies.push(...techSeen.values());
  const f = (area: Finding["area"], severity: Finding["severity"], title: string, detail: string) => c.out.findings.push({ id: uid("fd"), area, severity, title, detail, evidence: [rootEv] });
  if (errors5) f("quality", "medium", `${errors5} server error response(s) (5xx) in the capture`, "Server-side failures were observed during the recorded session.");
  if (errors4) f("quality", "low", `${errors4} client error response(s) (4xx) in the capture`, "Includes 401/403/404; check whether they are expected.");
  if (slow) f("performance", "low", `${slow} request(s) took longer than 3 s`, "Measured from the HAR timing fields.");
  if (insecure) f("security", mixed ? "medium" : "low", `${insecure} request(s) over plain http`, mixed ? "Some were loaded from an https page (mixed content)." : "Traffic to non-local hosts was not encrypted.");
  if (noSecureCookie) f("security", "low", `${noSecureCookie} cookie(s) set without the Secure attribute over https`, "Cookie values were not retained.");
  c.out.found.push({ path, kind: "har", detail: `${entries.length} requests, ${hosts.size} host(s)` });
}

/* ------------------------------ SBOM ------------------------------ */
const PURL_ECO: Record<string, Dependency["ecosystem"]> = { npm: "npm", pypi: "pypi", maven: "maven", golang: "go", cargo: "cargo", nuget: "nuget", gem: "gem", composer: "composer", swift: "swift" };
function sbom(path: string, doc: any, c: Ctx) {
  const rootEv = c.ev({ kind: "observed", method: "sbom", source: path, confidence: 1, summary: doc.bomFormat === "CycloneDX" ? `CycloneDX ${doc.specVersion ?? ""} SBOM: ${(doc.components ?? []).length} component(s)` : `${doc.spdxVersion} SBOM: ${(doc.packages ?? []).length} package(s)` });
  const list: { name: string; version?: string; purl?: string; lic?: string }[] = doc.bomFormat === "CycloneDX"
    ? (doc.components ?? []).map((x: any) => ({ name: String(x.group ? `${x.group}/${x.name}` : x.name), version: x.version, purl: x.purl, lic: x.licenses?.[0]?.license?.id ?? x.licenses?.[0]?.expression }))
    : (doc.packages ?? []).map((x: any) => ({ name: String(x.name), version: x.versionInfo, purl: (x.externalRefs ?? []).find((r: any) => r.referenceType === "purl")?.referenceLocator, lic: x.licenseConcluded && x.licenseConcluded !== "NOASSERTION" ? x.licenseConcluded : undefined }));
  let n = 0;
  for (const it of list.slice(0, 20000)) {
    const m = it.purl?.match(/^pkg:([a-z]+)\//i); const eco = (m && PURL_ECO[m[1]!.toLowerCase()]) || "other";
    c.out.dependencies.push({ name: it.name, version: it.version, ecosystem: eco, source: path, evidence: it.purl }); n++;
  }
  const copyleft = list.filter((x) => x.lic && /\b(?:AGPL|GPL|SSPL)\b/i.test(x.lic) && !/LGPL/i.test(x.lic));
  if (copyleft.length) c.out.findings.push({ id: uid("fd"), area: "quality", severity: "info", title: `${copyleft.length} component(s) under strong-copyleft licences`, detail: copyleft.slice(0, 8).map((x) => `${x.name} (${x.lic})`).join(", "), evidence: [rootEv] });
  c.out.found.push({ path, kind: "sbom", detail: `${n} component(s)` });
}

/* ------------------------------ logs ------------------------------ */
function logFile(path: string, text: string, c: Ctx) {
  const lines = text.split(/\r?\n/); const level = { fatal: 0, error: 0, warn: 0, info: 0, debug: 0 }; const sig = new Map<string, number>();
  for (const l of lines.slice(0, 200_000)) {
    const m = l.match(/\b(FATAL|CRITICAL|ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/); if (!m) continue;
    const k = m[1]!.toUpperCase(); if (k === "FATAL" || k === "CRITICAL") level.fatal++; else if (k.startsWith("ERR")) level.error++; else if (k.startsWith("WARN")) level.warn++; else if (k === "INFO") level.info++; else level.debug++;
    if (level.fatal || k.startsWith("ERR") || k === "FATAL") { const s = redactSecrets(l).text.replace(/\d{4}-\d\d-\d\d[T ][\d:.,+Z-]+/g, "").replace(/\b\d+\b/g, "N").replace(/0x[0-9a-f]+/gi, "0xN").replace(/\s+/g, " ").trim().slice(0, 160); if (k.startsWith("ERR") || k === "FATAL" || k === "CRITICAL") sig.set(s, (sig.get(s) ?? 0) + 1); }
  }
  const top = [...sig].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const id = c.ev({ kind: "observed", method: "log", source: path, confidence: 1, summary: `Log: ${lines.length} line(s) — ${level.fatal} fatal, ${level.error} error, ${level.warn} warning`, snippet: top.map(([s, n]) => `${n}× ${s}`).join("\n").slice(0, 600) || undefined });
  if (level.fatal + level.error) c.out.findings.push({ id: uid("fd"), area: "quality", severity: level.fatal ? "high" : "medium", title: `${path}: ${level.fatal + level.error} error line(s)`, detail: top.length ? `Most frequent: ${top.slice(0, 3).map(([s, n]) => `${n}× “${s.slice(0, 90)}”`).join("; ")}` : "No distinct error signatures.", evidence: [id] });
  c.out.found.push({ path, kind: "log", detail: `${lines.length} lines, ${level.error + level.fatal} errors, ${level.warn} warnings` });
}

/** Scan supplied files for technical artifacts. Files that are not artifacts are ignored (they remain ordinary source). */
export function analyzeTechnicalArtifacts(inputs: InputFile[], opts: { maxBytes?: number } = {}): ArtifactAnalysis {
  const out: ArtifactAnalysis = { found: [], endpoints: [], dependencies: [], features: [], findings: [], evidence: [], technologies: [], thirdParties: [], notes: [] };
  const ev: Ctx["ev"] = (e) => { const id = uid("ev"); out.evidence.push({ id, timestamp: now(), ...e }); return id; };
  const c: Ctx = { ev, out };
  const max = opts.maxBytes ?? 60_000_000;
  for (const f of inputs) {
    if (f.data.byteLength > max) { if (/\.(?:har|json|ya?ml|log|graphql|gql)$/i.test(f.path)) out.notes.push(`${f.path}: ${(f.data.byteLength / 1e6).toFixed(0)} MB is over the ${(max / 1e6).toFixed(0)} MB artifact limit; not parsed`); continue; }
    if (!/\.(?:json|ya?ml|har|log|txt|graphql|gql|spdx)$/i.test(f.path)) continue;
    if (f.data.byteLength > 2_000_000 && !/\.(?:har|log|json)$/i.test(f.path)) continue;
    let text: string; try { text = dec.decode(f.data); } catch { continue; }
    const kind = detectArtifact(f.path, text); if (!kind) continue;
    try {
      if (kind === "graphql") graphql(f.path, text, c);
      else if (kind === "log") logFile(f.path, text, c);
      else {
        const doc = /\.ya?ml$/i.test(f.path) ? tryYaml(text) : (tryJson(text) ?? tryYaml(text));
        if (!doc) { out.notes.push(`${f.path}: looked like ${kind} but could not be parsed`); continue; }
        if (kind === "openapi") openApi(f.path, doc, c); else if (kind === "har") har(f.path, doc, c); else if (kind === "sbom") sbom(f.path, doc, c);
      }
    } catch (e) { out.notes.push(`${f.path}: ${kind} parse error (${(e as Error).message.slice(0, 100)})`); }
  }
  return out;
}
