/**
 * Persistent analysis report: the 20 sections required by the spec, every
 * finding linked to evidence ids, unknowns stated explicitly.
 * Imported material is untrusted → every value is escaped for its output format.
 */
import { strToU8, zipSync } from "fflate";
import type { Evidence, EvidenceKind, Investigation } from "../schema.js";
import { formatBytes } from "../util/index.js";
import { safeEntryPath } from "../analyze/archive.js";

export interface ReportSection {
  n: number;
  id: string;
  title: string;
  md: string;
}

const BADGE: Record<EvidenceKind, string> = {
  observed: "OBSERVED", recovered: "RECOVERED", dynamic: "DYNAMIC", reconstructed: "RECONSTRUCTED", inferred: "INFERRED", unavailable: "UNAVAILABLE",
};

export const mdEsc = (s: string) => String(s ?? "").replace(/[\\`*_{}[\]<>|]/g, "\\$&").replace(/\r?\n/g, " ");
export const htmlEsc = (s: string) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const table = (head: string[], rows: (string | number | undefined)[][]) =>
  rows.length ? `| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|\n${rows.map((r) => `| ${r.map((c) => mdEsc(String(c ?? ""))).join(" | ")} |`).join("\n")}\n` : "_None found._\n";

const evRef = (ids: string[], max = 3) => (ids.length ? ids.slice(0, max).map((i) => `\`${i}\``).join(" ") + (ids.length > max ? ` +${ids.length - max}` : "") : "—");
const path = (u: string) => { try { const x = new URL(u); return (x.pathname || "/") + x.search; } catch { return u; } };

export function mermaidSitemap(inv: Investigation, limit = 60): string {
  const pages = inv.pages.filter((p) => p.status < 400).slice(0, limit);
  const idx = new Map(pages.map((p, i) => [p.url, `P${i}`]));
  const lines = ["graph TD"];
  for (const p of pages) lines.push(`  ${idx.get(p.url)}["${path(p.url).replace(/"/g, "'").slice(0, 40)}"]`);
  const seen = new Set<string>();
  for (const p of pages) for (const l of p.links) {
    const t = idx.get(l.split("#")[0]!);
    const k = `${idx.get(p.url)}>${t}`;
    if (t && t !== idx.get(p.url) && !seen.has(k)) { seen.add(k); lines.push(`  ${idx.get(p.url)} --> ${t}`); }
  }
  return lines.join("\n");
}

export function mermaidStack(inv: Investigation): string {
  const byCat = new Map<string, string[]>();
  for (const t of inv.technologies.filter((t) => t.confidence >= 0.5)) byCat.set(t.category, [...(byCat.get(t.category) ?? []), t.name]);
  const lines = ["graph LR", `  S(("${inv.name.replace(/"/g, "'").slice(0, 30)}"))`];
  let i = 0;
  for (const [cat, names] of byCat) lines.push(`  S --> C${i}["${cat}: ${names.slice(0, 4).join(", ").replace(/"/g, "'")}"]`), i++;
  return lines.join("\n");
}

export function recommendations(inv: Investigation): string[] {
  const rec: string[] = [];
  const tech = new Set(inv.technologies.map((t) => t.name));
  if (inv.files.length) rec.push(`**Source is partially recoverable** (${inv.files.length} file(s) from public source maps). Confirm the licence/ownership before reuse; otherwise treat them as reference and reimplement independently.`);
  else rec.push("**No original source was recovered.** Use *Functional recreation* (Mode 1) or *Visual recreation* (Mode 2); the implementation will be independent, driven by the behaviour specs and evidence below.");
  const stack = ["Next.js", "React", "Vue.js", "Nuxt", "Svelte", "SvelteKit", "Angular", "Astro"].filter((t) => tech.has(t));
  if (stack.length) rec.push(`Match the observed front-end stack (${stack.join(", ")}) for parity, or choose a modern equivalent (*Modernized version*, Mode 4).`);
  if (tech.has("Tailwind CSS")) rec.push("Reuse Tailwind CSS; design tokens extracted from the stylesheets are in the report data (`designTokens`).");
  const apis = inv.endpoints.filter((e) => e.kind === "rest" || e.kind === "graphql");
  if (apis.length) rec.push(`Implement ${apis.length} API contract(s) server-side. Request/response shapes are **unknown** from static analysis; record them with an authorised interactive session or define them in the new backend.`);
  if (inv.features.some((f) => f.name === "Authentication")) rec.push("Authentication is present: choose a provider (e.g. Auth.js, Clerk, Supabase Auth); session logic cannot be recovered from the front end.");
  if (inv.coverage.checks.find((c) => c.id === "render")?.status === "skipped") rec.push("Re-run with **rendering enabled** (desktop app) to capture client-rendered UI and runtime network calls before rebuilding.");
  rec.push("Use *Feature extraction* to recreate individual features (e.g. " + (inv.features.slice(0, 3).map((f) => f.name).join(", ") || "none detected") + ") inside an existing project.");
  return rec;
}

export function buildSections(inv: Investigation): ReportSection[] {
  const ok = inv.pages.filter((p) => p.status >= 200 && p.status < 400);
  const evBy = (k: EvidenceKind) => inv.evidence.filter((e) => e.kind === k);
  const assetsByKind: Record<string, number> = {};
  for (const a of inv.assets) assetsByKind[a.kind] = (assetsByKind[a.kind] ?? 0) + 1;
  const totalBytes = inv.assets.reduce((n, a) => n + (a.bytes ?? 0), 0) + inv.pages.reduce((n, p) => n + p.bytes, 0);
  const sec = (n: number, id: string, title: string, md: string): ReportSection => ({ n, id, title, md });
  const out: ReportSection[] = [];

  out.push(sec(1, "overview", "Executive application overview",
    `**${mdEsc(inv.name)}** — ${ok.length} page(s), ${inv.assets.length} asset(s), ${inv.technologies.length} technolog${inv.technologies.length === 1 ? "y" : "ies"}, ${inv.features.length} feature(s), ${inv.evidence.length} evidence record(s).\n\n` +
    `Status: \`${inv.status}\` · Coverage: **${Math.round(inv.coverage.score * 100)}%** of applicable checks (see section 19) · Fetched ≈ ${formatBytes(totalBytes)}.\n\n` +
    (inv.summary ? `> **AI-written summary** (model output, not evidence):\n> ${inv.summary.split("\n").map(mdEsc).join("\n> ")}\n\n` : "") +
    `Headline stack: ${inv.technologies.filter((t) => t.confidence >= 0.8).slice(0, 8).map((t) => `${t.name}${t.version ? " " + t.version : ""}`).join(", ") || "_none detected with high confidence_"}.\n`));

  out.push(sec(2, "scope", "Input sources and analysis scope",
    table(["Target", "Kind"], inv.targets.map((t) => [t.value, t.kind])) +
    `\nMode: \`${inv.config.mode}\` · max depth ${inv.config.maxDepth} · max pages ${inv.config.maxPages} · concurrency ${inv.config.concurrency} · delay ${inv.config.delayMs} ms · robots.txt ${inv.config.respectRobots ? "respected" : "**not** respected (user override)"} · subdomains ${inv.config.includeSubdomains ? "included" : "excluded"} · third-party assets ${inv.config.inspectExternal ? "inspected" : "not fetched"}.\n\nStarted ${inv.startedAt}${inv.finishedAt ? `, finished ${inv.finishedAt}` : ""}. Only publicly reachable content was requested; no authentication, paywall or CAPTCHA was bypassed.\n`));

  out.push(sec(3, "stack", "Technology stack",
    table(["Technology", "Category", "Version", "Confidence", "Evidence"], inv.technologies.map((t) => [t.name, t.category, t.version ?? "unknown", `${Math.round(t.confidence * 100)}%`, evRef(t.evidence)])) +
    "\n_Confidence combines independent matched signals (1 − Π(1 − cᵢ)); it is computed by rule, not estimated by a model._\n"));

  out.push(sec(4, "architecture", "Architecture diagrams",
    "**Sitemap / navigation graph**\n\n```mermaid\n" + mermaidSitemap(inv) + "\n```\n\n**Technology map**\n\n```mermaid\n" + mermaidStack(inv) + "\n```\n"));

  out.push(sec(5, "inventory", "File and asset inventory",
    `Assets by kind: ${Object.entries(assetsByKind).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.\n\n` +
    table(["Asset", "Kind", "Status", "Size", "SHA-256"], inv.assets.slice(0, 200).map((a) => [path(a.url), a.kind, a.status ?? (a.skippedReason ? "skipped" : "—"), a.bytes !== undefined ? formatBytes(a.bytes) : "unknown", a.hash ? a.hash.slice(0, 12) + "…" : a.skippedReason ?? "—"])) +
    (inv.assets.length > 200 ? `\n… ${inv.assets.length - 200} more in the JSON export.\n` : "")));

  out.push(sec(6, "dependencies", "Dependencies",
    table(["Name", "Version", "Ecosystem", "Dev", "Source"], inv.dependencies.slice(0, 300).map((d) => [d.name, d.version ?? "—", d.ecosystem, d.dev ? "yes" : "", d.source.slice(0, 60)])) +
    (inv.envVars?.length ? `\nEnvironment variable **names** referenced (values never read): ${inv.envVars.map((e) => `\`${e.name}\``).join(", ")}.\n` : "")));

  out.push(sec(7, "components", "Component hierarchy",
    inv.components?.length ? table(["Component", "Source", "Provenance"], inv.components.slice(0, 150).map((c) => [c.name, path(c.source), BADGE[c.provenance]])) + "\n_Names come from AST analysis of shipped bundles; minified builds often rename components, so absence is not evidence of absence._\n" : "_No components could be identified (client-rendered content needs rendering; bundles may be minified beyond recognition)._\n"));

  out.push(sec(8, "routes", "Navigation and routes",
    table(["Route", "Found via", "Where"], (inv.routes ?? []).slice(0, 200).map((r) => [r.route, r.via, path(r.source)]))));

  out.push(sec(9, "features", "Feature inventory",
    inv.features.length ? inv.features.map((f) => `### ${mdEsc(f.name)}  \`${BADGE[f.provenance]}\` · ${Math.round(f.confidence * 100)}%\n${mdEsc(f.description)}\n\n- **Purpose:** ${mdEsc(f.spec.purpose)}\n- **Inputs:** ${f.spec.inputs.map(mdEsc).join("; ") || "—"}\n- **Outputs:** ${f.spec.outputs.map(mdEsc).join("; ") || "—"}\n- **States:** ${f.spec.states.map(mdEsc).join("; ")}\n- **Dependencies:** ${f.spec.dependencies.map(mdEsc).join(", ") || "—"}\n- **Errors:** ${f.spec.errorStates.map(mdEsc).join("; ")}\n- **Accessibility:** ${f.spec.accessibility.map(mdEsc).join("; ") || "—"}\n- **Hypotheses:** ${f.spec.hypotheses.map(mdEsc).join("; ") || "—"}\n- **Evidence:** ${evRef(f.evidence, 5)}\n`).join("\n") : "_No features could be established from the evidence._\n"));

  out.push(sec(10, "dataflow", "Observable data flows",
    table(["Endpoint", "Kind", "Method", "Called from", "Evidence"], inv.endpoints.slice(0, 150).map((e) => [e.url, e.kind, e.method ?? "?", path(e.foundIn), evRef([e.evidence], 1)])) +
    "\n_Payload shapes and server behaviour are **not** visible from static analysis._\n"));

  out.push(sec(11, "services", "API and service relationships",
    table(["Third-party host", "Loaded as", "Count"], (inv.thirdParties ?? []).slice(0, 80).map((t) => [t.host, t.kinds.join(", "), t.count]))));

  const telemetry = inv.technologies.filter((t) => /Analytics|Session replay|Error monitoring|Performance monitoring|Advertising|Tag manager/.test(t.category));
  out.push(sec(12, "telemetry", "Observable analytics and telemetry",
    table(["Service", "Category", "Confidence", "Evidence"], telemetry.map((t) => [t.name, t.category, `${Math.round(t.confidence * 100)}%`, evRef(t.evidence)]))));

  out.push(sec(13, "recovered", "Recovered code and artifacts (exact originals)",
    inv.files.length ? table(["Path", "Language", "Lines", "SHA-256", "Origin"], inv.files.slice(0, 300).map((f) => [f.path, f.language, f.lines, f.hash.slice(0, 12) + "…", f.origin.slice(0, 70)])) : "_Nothing was recovered verbatim. No public source map shipped original sources._\n"));

  out.push(sec(14, "reconstructed", "Reconstructed code and architecture (readable, not original)",
    (evBy("reconstructed").length ? evBy("reconstructed").slice(0, 40).map((e) => `- \`${e.id}\` ${mdEsc(e.summary)} — ${mdEsc(path(e.source))}`).join("\n") : "_None._") + "\n"));

  out.push(sec(15, "inferred", "Inferred implementation details",
    (evBy("inferred").length ? evBy("inferred").slice(0, 40).map((e) => `- \`${e.id}\` ${mdEsc(e.summary)} (${Math.round(e.confidence * 100)}%)`).join("\n") : "_None._") + "\n\n_Inferences are labelled as such and never presented as recovered code._\n"));

  const fArea = (a: string) => inv.findings.filter((f) => f.area === a);
  const fTable = (a: string) => table(["Severity", "Finding", "Evidence"], fArea(a).map((f) => [f.severity, f.title, evRef(f.evidence, 2)]));
  out.push(sec(16, "performance", "Performance observations", fTable("performance")));
  out.push(sec(17, "accessibility", "Accessibility observations", fTable("accessibility")));
  out.push(sec(18, "security", "Security observations (passive, authorised scope only)", fTable("security") + "\n_These are observations from responses already fetched; nothing was probed or exploited._\n"));

  out.push(sec(19, "limitations", "Known limitations and coverage",
    `**Coverage ${Math.round(inv.coverage.score * 100)}%** = (done + ½·partial) ÷ applicable checks. Unavailable layers are excluded from the denominator and listed below instead of hidden.\n\n` +
    table(["Check", "Status", "Detail"], inv.coverage.checks.map((c) => [c.label, c.status, c.detail])) +
    (inv.limitations.length ? "\n**Limitations**\n" + inv.limitations.map((l) => `- ${mdEsc(l)}`).join("\n") + "\n" : "") +
    (inv.questions.length ? "\n**Unresolved questions**\n" + inv.questions.map((q) => `- ${mdEsc(q)}`).join("\n") + "\n" : "")));

  out.push(sec(20, "recommendations", "Reconstruction recommendations", recommendations(inv).map((r) => `- ${r}`).join("\n") + "\n"));
  return out;
}

export function renderMarkdown(inv: Investigation): string {
  const head = `# Analysis report — ${mdEsc(inv.name)}\n\n_Generated by OmniForge RE · investigation \`${inv.id}\` · ${inv.finishedAt ?? inv.startedAt}_\n\n> Evidence legend: **OBSERVED** directly fetched/seen · **RECOVERED** exact original · **DYNAMIC** seen at runtime · **RECONSTRUCTED** readable form of a bundle · **INFERRED** concluded from other evidence · **UNAVAILABLE** examined, not obtainable.\n\n`;
  return head + buildSections(inv).map((s) => `## ${s.n}. ${s.title}\n\n${s.md}`).join("\n") + "\n## Appendix — Evidence index\n\n" + evidenceTable(inv.evidence.slice(0, 400)) + (inv.evidence.length > 400 ? `\n… ${inv.evidence.length - 400} more in evidence.json\n` : "");
}

function evidenceTable(ev: Evidence[]) {
  return table(["ID", "Kind", "Method", "Source", "Confidence", "Hash", "Summary"], ev.map((e) => [e.id, BADGE[e.kind], e.method, path(e.source).slice(0, 60), `${Math.round(e.confidence * 100)}%`, e.hash ? e.hash.slice(0, 10) + "…" : "", e.summary.slice(0, 90)]));
}

/** Minimal, safe Markdown → HTML for our own generated markdown (all input already escaped). */
function mdToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  // code spans are lifted out first so underscores inside them (ids like inv_abc) can't break emphasis matching
  const inline = (s: string) => {
    const codes: string[] = [];
    return htmlEsc(s.replace(/\u0000/g, "").replace(/\\([\\`*_{}[\]<>|])/g, "$1"))
      .replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${codes.push(c) - 1}\u0000`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<![*\w])_([^_]+)_(?!\w)/g, "<em>$1</em>")
      .replace(/\u0000(\d+)\u0000/g, (_m, n: string) => `<code>${codes[Number(n)]}</code>`);
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith("```")) {
      const lang = l.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      out.push(`<pre class="${htmlEsc(lang)}"><code>${htmlEsc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (l.startsWith("|") && lines[i + 1]?.startsWith("|---")) {
      const cells = (r: string) => r.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
      const head = cells(l);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) rows.push(cells(lines[i++]!));
      out.push(`<div class="tw"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const h = l.match(/^(#{1,4}) (.*)/);
    if (h) { out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`); i++; continue; }
    if (l.startsWith("> ")) { const q: string[] = []; while (i < lines.length && lines[i]!.startsWith("> ")) q.push(lines[i++]!.slice(2)); out.push(`<blockquote>${inline(q.join(" "))}</blockquote>`); continue; }
    if (/^- /.test(l)) { const li: string[] = []; while (i < lines.length && /^- /.test(lines[i]!)) li.push(`<li>${inline(lines[i++]!.slice(2))}</li>`); out.push(`<ul>${li.join("")}</ul>`); continue; }
    if (!l.trim()) { i++; continue; }
    out.push(`<p>${inline(l)}</p>`);
    i++;
  }
  return out.join("\n");
}

export function renderHtml(inv: Investigation): string {
  const md = renderMarkdown(inv);
  const toc = buildSections(inv).map((s) => `<a href="#s${s.n}">${s.n}. ${htmlEsc(s.title)}</a>`).join("");
  const body = mdToHtml(md).replace(/<h2>(\d+)\. /g, (_m, n) => `<h2 id="s${n}">${n}. `);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Analysis report — ${htmlEsc(inv.name)}</title>
<style>:root{--bg:#fff;--fg:#111827;--mut:#6b7280;--line:#e5e7eb;--acc:#4f46e5;--code:#f3f4f6}@media(prefers-color-scheme:dark){:root{--bg:#0b0d12;--fg:#e5e7eb;--mut:#9ca3af;--line:#1f2430;--acc:#818cf8;--code:#141824}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Inter,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:24px 16px 80px}nav.toc{display:flex;flex-wrap:wrap;gap:6px 14px;padding:12px 0;border-bottom:1px solid var(--line);margin-bottom:12px;font-size:13px}nav.toc a{color:var(--acc);text-decoration:none}
h1{font-size:28px}h2{margin-top:40px;padding-top:12px;border-top:1px solid var(--line);font-size:20px}h3{font-size:16px}code{background:var(--code);padding:1px 5px;border-radius:4px;font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);padding:12px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}.tw{overflow:auto;margin:10px 0}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top;word-break:break-word}th{color:var(--mut);font-weight:600}
blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid var(--acc);color:var(--mut)}@media print{nav.toc{display:none}body{font-size:11px}h2{break-after:avoid}pre,table{break-inside:avoid}}</style></head>
<body><div class="wrap"><nav class="toc">${toc}</nav>${body}</div></body></html>`;
}

export function graphExport(inv: Investigation) {
  return { nodes: inv.graph.nodes, edges: inv.graph.edges, format: "omniforge-graph/1" };
}

/** ZIP bundle: report in every format + graph + evidence + recovered sources. */
export function exportBundle(inv: Investigation): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "report.json": strToU8(JSON.stringify(inv, null, 2)),
    "report.md": strToU8(renderMarkdown(inv)),
    "report.html": strToU8(renderHtml(inv)),
    "graph.json": strToU8(JSON.stringify(graphExport(inv), null, 2)),
    "evidence.json": strToU8(JSON.stringify(inv.evidence, null, 2)),
    "features.json": strToU8(JSON.stringify(inv.features, null, 2)),
    "README.txt": strToU8(`OmniForge RE analysis bundle for ${inv.name}\n\nreport.* – full report\ngraph.json – nodes/edges for every diagram\nevidence.json – every evidence record with hash/method/source\nrecovered/ – original files recovered verbatim from public source maps (may be subject to the owner's licence)\n`),
  };
  for (const f of inv.files) {
    const safe = safeEntryPath(f.path);
    if (safe && f.content !== undefined) files[`recovered/${safe}`] = strToU8(f.content);
  }
  return zipSync(files, { level: 6 });
}
