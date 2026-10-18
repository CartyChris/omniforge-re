/**
 * Investigation coverage. The score is computed from checks that actually ran
 * (done = 1, partial = 0.5) over the checks that were applicable. Layers that
 * cannot be observed at all are marked `unavailable`, excluded from the
 * denominator and reported under limitations — never silently dropped.
 */
import type { Coverage, CoverageCheck } from "../schema.js";
import type { Facts } from "./facts.js";

export function computeCoverage(f: Facts, cfg: { render: boolean; deobfuscate?: boolean; fetchAssets: boolean; followSitemaps: boolean; respectRobots: boolean; inspectExternal: boolean }): { coverage: Coverage; limitations: string[] } {
  const checks: CoverageCheck[] = [];
  const limitations: string[] = [];
  const add = (id: string, label: string, status: CoverageCheck["status"], detail: string) => checks.push({ id, label, status, detail });

  const ok = f.pages.filter((p) => p.status >= 200 && p.status < 400);
  add("pages", "Pages fetched and parsed", ok.length ? (f.limits.maxPagesHit ? "partial" : "done") : "partial", `${ok.length} page(s) parsed${f.limits.maxPagesHit ? `; stopped at limit with ${f.limits.queueRemaining} URL(s) unvisited` : ""}`);

  if (cfg.respectRobots) add("robots", "robots.txt consulted", f.robots.length ? "done" : "partial", f.robots.map((r) => `${r.host}: ${r.found ? `${r.disallowed} disallow rule(s)` : "none published"}`).join("; ") || "not retrieved");
  else add("robots", "robots.txt consulted", "skipped", "Disabled in crawl settings");

  if (cfg.followSitemaps) add("sitemap", "Sitemaps parsed", f.sitemapUrls ? "done" : "partial", f.sitemapUrls ? `${f.sitemapUrls} URL(s) listed` : "No sitemap published or discoverable");
  else add("sitemap", "Sitemaps parsed", "skipped", "Disabled in crawl settings");

  if (cfg.fetchAssets) {
    const fetched = f.assets.filter((a) => a.fetched).length;
    const candidates = f.assets.filter((a) => ["script", "style", "manifest", "worker", "sourcemap", "wasm"].includes(a.kind));
    const missed = candidates.filter((a) => !a.fetched).length;
    add("assets", "Scripts, styles and manifests fetched", missed === 0 ? "done" : "partial", `${fetched} fetched${missed ? `, ${missed} not fetched (${f.limits.assetsOverLimit} over size limit${cfg.inspectExternal ? "" : "; third-party skipped"})` : ""}`);
  } else add("assets", "Scripts, styles and manifests fetched", "skipped", "Asset fetching disabled");

  const jsFiles = [...f.js.values()];
  const ast = jsFiles.filter((j) => j.method === "ast").length;
  add("js", "JavaScript parsed to an AST", jsFiles.length === 0 ? "partial" : ast === jsFiles.length ? "done" : "partial", jsFiles.length ? `${ast}/${jsFiles.length} bundle(s) parsed as AST; remainder lexical (too large or unparsable)` : "No scripts were analysed");

  add("fingerprint", "Technology fingerprinting", "done", `${f.technologies.length} technolog${f.technologies.length === 1 ? "y" : "ies"} with linked evidence`);

  const declared = f.sourceMaps.length;
  if (declared) add("sourcemaps", "Source maps", f.sourceMaps.some((m) => m.recovered > 0) ? "done" : "partial", `${f.sourceMaps.filter((m) => m.ok).length}/${declared} declared map(s) parsed; ${f.sourceMaps.reduce((n, m) => n + m.recovered, 0)} file(s) recovered`);
  else add("sourcemaps", "Source maps", "unavailable", "No source map is declared by any script — original sources are not publicly shipped");

  if (cfg.deobfuscate) {
    const d = f.deobfuscation;
    if (!d) add("deobfuscation", "JavaScript deobfuscated / bundles split", "unavailable", "Requested, but this analysis ran without the sandboxed deobfuscation engine (desktop app only)");
    else if (d.candidates === 0) add("deobfuscation", "JavaScript deobfuscated / bundles split", "done", "No script looked minified or obfuscated beyond reading");
    else add("deobfuscation", "JavaScript deobfuscated / bundles split", d.ok === d.candidates ? "done" : d.ok > 0 ? "partial" : "partial", `${d.ok}/${d.candidates} candidate script(s) made readable${d.unpacked ? ` (${d.unpacked} bundle(s) split into modules)` : ""}${d.failed ? `; ${d.failed} failed` : ""}${d.skipped ? `; ${d.skipped} skipped (third-party, too large, or over the per-run limit)` : ""}. Output is a reconstruction: original names and comments are not recoverable`);
  }

  add("render", "Rendered DOM (JavaScript executed)", f.rendered ? "done" : "skipped", f.rendered ? "Pages rendered in a headless browser" : "Static HTML only. Client-rendered content is invisible without rendering (available in the desktop app / local worker)");
  add("interaction", "Interactive behaviour exercised", f.rendered ? "partial" : "skipped", f.rendered ? "Navigation and safe clicks recorded; no destructive actions attempted" : "Not performed; behaviour specs list unobserved states as “Unknown”");
  add("auth", "Authenticated areas", "unavailable", "Not accessed. Only publicly reachable content was analysed; an explicitly authorised browser-session mode is required for logged-in views");
  add("server", "Server-side logic", "unavailable", "Private backend source and behaviour cannot be recovered from frontend artifacts");

  const applicable = checks.filter((c) => c.status !== "unavailable");
  const score = applicable.length ? applicable.reduce((n, c) => n + (c.status === "done" ? 1 : c.status === "partial" ? 0.5 : 0), 0) / applicable.length : 0;

  for (const c of checks) if (c.status === "unavailable" || c.status === "skipped") limitations.push(`${c.label}: ${c.detail}`);
  if (f.failedFetches.length) limitations.push(`${f.failedFetches.length} request(s) failed and are absent from the results.`);
  if (f.blockedByRobots.length) limitations.push(`${f.blockedByRobots.length} URL(s) not fetched because robots.txt disallows them.`);
  return { coverage: { score: Math.round(score * 100) / 100, checks }, limitations };
}
