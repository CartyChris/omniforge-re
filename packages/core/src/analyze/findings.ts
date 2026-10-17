/**
 * Passive observations (performance, accessibility, SEO, security headers).
 * Nothing here probes or exploits; it only interprets responses already
 * fetched during the crawl.
 */
import type { Evidence, Finding } from "../schema.js";
import { formatBytes, now, uid } from "../util/index.js";
import type { Facts } from "./facts.js";

export function deriveFindings(f: Facts): { findings: Finding[]; evidence: Evidence[] } {
  const findings: Finding[] = [];
  const evidence: Evidence[] = [];
  const ev = (method: string, source: string, summary: string, confidence = 1): string => {
    const e: Evidence = { id: uid("ev"), kind: "observed", method, source, timestamp: now(), confidence, summary };
    evidence.push(e);
    return e.id;
  };
  const add = (area: Finding["area"], severity: Finding["severity"], title: string, detail: string, evidenceIds: string[]) => {
    findings.push({ id: uid("fd"), area, severity, title, detail, evidence: evidenceIds });
  };

  const htmlPages = f.pages.filter((p) => p.status >= 200 && p.status < 300 && /html/i.test(p.contentType));
  const first = htmlPages[0];

  /* ---------- Security headers (first successful HTML page + any https) ---------- */
  if (first) {
    const h = f.responseHeaders.get(first.url) ?? {};
    const isHttps = first.url.startsWith("https:");
    const missing: { header: string; why: string; sev: Finding["severity"] }[] = [];
    if (isHttps && !h["strict-transport-security"]) missing.push({ header: "Strict-Transport-Security", why: "Browsers are not told to insist on HTTPS", sev: "medium" });
    if (!h["content-security-policy"]) missing.push({ header: "Content-Security-Policy", why: "No policy restricting script/style/frame sources", sev: "medium" });
    if (!h["x-content-type-options"]) missing.push({ header: "X-Content-Type-Options", why: "MIME sniffing is not disabled", sev: "low" });
    if (!h["x-frame-options"] && !/frame-ancestors/i.test(h["content-security-policy"] ?? "")) missing.push({ header: "X-Frame-Options / frame-ancestors", why: "Page can be framed by other origins (clickjacking surface)", sev: "low" });
    if (!h["referrer-policy"]) missing.push({ header: "Referrer-Policy", why: "Default referrer behaviour applies", sev: "info" });
    if (!h["permissions-policy"]) missing.push({ header: "Permissions-Policy", why: "No restriction of powerful browser features", sev: "info" });
    for (const m of missing) add("security", m.sev, `Missing ${m.header}`, m.why, [ev("header-check", first.url, `Response header absent: ${m.header}`)]);
    if (h["server"] && /\d+\.\d+/.test(h["server"])) add("security", "info", "Server header discloses a version", `Server: ${h["server"]}`, [ev("header-check", first.url, `Server: ${h["server"]}`)]);
    if (h["x-powered-by"]) add("security", "info", "X-Powered-By header present", `X-Powered-By: ${h["x-powered-by"]}`, [ev("header-check", first.url, `X-Powered-By: ${h["x-powered-by"]}`)]);
  }
  const seenCookies = new Set<string>();
  for (const c of f.cookies) {
    if (seenCookies.has(c.name)) continue;
    seenCookies.add(c.name);
    const weak: string[] = [];
    if (!c.secure && c.url.startsWith("https:")) weak.push("no Secure flag");
    if (!c.httpOnly && /sess|auth|token|sid/i.test(c.name)) weak.push("no HttpOnly flag on a session-like cookie");
    if (!c.sameSite) weak.push("no SameSite attribute");
    if (weak.length) add("security", "low", `Cookie “${c.name}”: ${weak.join("; ")}`, "Cookie attributes observed on the Set-Cookie header (value not retained).", [ev("cookie-attrs", c.url, `${c.name}: ${weak.join(", ")}`)]);
  }
  const insecure = new Set(htmlPages.flatMap((p) => f.extracted.get(p.url)?.insecureSubresources ?? []));
  if (insecure.size) add("security", "medium", `${insecure.size} insecure (http://) subresource(s) on HTTPS pages`, [...insecure].slice(0, 8).join("\n"), [ev("html-scan", first?.url ?? "", `${insecure.size} mixed-content references`)]);
  const noSri = new Set(htmlPages.flatMap((p) => f.extracted.get(p.url)?.crossOriginScriptsWithoutSri ?? []));
  if (noSri.size) add("security", "info", `${noSri.size} cross-origin script/style reference(s) without Subresource Integrity`, [...noSri].slice(0, 8).join("\n"), [ev("html-scan", first?.url ?? "", `${noSri.size} references lack integrity=`)]);
  for (const s of f.secretLikeInAssets) add("security", "high", "Secret-shaped value in a public asset", `${s.kinds.join(", ")} pattern found in ${s.url}. The value is NOT stored; verify manually and rotate if it is a live credential.`, [ev("secret-scan", s.url, `Secret-shaped strings (${s.kinds.join(", ")}) — values redacted`, 0.7)]);
  for (const m of f.sourceMaps.filter((m) => m.ok && m.recovered > 0)) add("security", "info", "Public source map exposes original source", `${m.url} ships sourcesContent for ${m.recovered} first-party file(s).`, [ev("sourcemap", m.url, `${m.recovered}/${m.total} sources recovered`)]);

  /* ---------- Performance ---------- */
  const scripts = f.assets.filter((a) => a.kind === "script" && a.bytes);
  const totalJs = scripts.reduce((n, a) => n + (a.bytes ?? 0), 0);
  if (totalJs > 1_000_000) add("performance", totalJs > 3_000_000 ? "high" : "medium", `JavaScript payload is ${formatBytes(totalJs)} (uncompressed)`, `${scripts.length} script file(s). Largest: ${scripts.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 3).map((a) => `${a.url.split("/").pop()} ${formatBytes(a.bytes ?? 0)}`).join(", ")}`, [ev("asset-size", "assets", `${formatBytes(totalJs)} of JS across ${scripts.length} files`)]);
  const textAssets = f.assets.filter((a) => (a.kind === "script" || a.kind === "style") && (a.bytes ?? 0) > 20_000);
  const uncompressed = textAssets.filter((a) => !(f.responseHeaders.get(a.url) ?? {})["content-encoding"]);
  if (uncompressed.length) add("performance", "medium", `${uncompressed.length} large text asset(s) served without compression`, uncompressed.slice(0, 6).map((a) => a.url).join("\n"), [ev("header-check", uncompressed[0]!.url, "No Content-Encoding on text asset >20 KB")]);
  const uncached = f.assets.filter((a) => (a.kind === "script" || a.kind === "style" || a.kind === "font") && a.fetched && !(f.responseHeaders.get(a.url) ?? {})["cache-control"]);
  if (uncached.length) add("performance", "low", `${uncached.length} static asset(s) without Cache-Control`, uncached.slice(0, 6).map((a) => a.url).join("\n"), [ev("header-check", uncached[0]!.url, "No Cache-Control on static asset")]);
  const blocking = htmlPages.reduce((n, p) => n + (f.extracted.get(p.url)?.blockingScripts ?? 0), 0);
  if (blocking) add("performance", "low", `${blocking} render-blocking <script src> in <head> (no async/defer/module)`, "Blocking scripts delay first paint.", [ev("html-scan", first?.url ?? "", `${blocking} blocking head scripts`)]);
  const slow = f.pages.filter((p) => p.ms > 2000);
  if (slow.length) add("performance", "info", `${slow.length} page(s) took over 2 s to respond`, slow.slice(0, 5).map((p) => `${p.url} ${p.ms} ms`).join("\n"), [ev("timing", slow[0]!.url, `${slow[0]!.ms} ms server response (from this crawler's vantage point)`, 0.6)]);

  /* ---------- Accessibility ---------- */
  const a11y = htmlPages.map((p) => ({ p, e: f.extracted.get(p.url)! })).filter((x) => x.e);
  const noLang = a11y.filter((x) => !x.e.a11y.hasLang);
  if (noLang.length) add("accessibility", "medium", `${noLang.length} page(s) missing <html lang>`, "Screen readers cannot pick the correct pronunciation.", [ev("html-scan", noLang[0]!.p.url, "html element has no lang attribute")]);
  const noMain = a11y.filter((x) => !x.e.a11y.hasMain);
  if (noMain.length) add("accessibility", "low", `${noMain.length} page(s) without a <main> landmark`, "Skip-navigation and landmark navigation are harder.", [ev("html-scan", noMain[0]!.p.url, "no <main> / role=main")]);
  const imgs = a11y.reduce((n, x) => n + x.e.a11y.imagesWithoutAlt, 0);
  if (imgs) add("accessibility", "medium", `${imgs} image(s) without alt attribute`, "Informative images need text alternatives; decorative ones should use alt=\"\".", [ev("html-scan", a11y.find((x) => x.e.a11y.imagesWithoutAlt)!.p.url, `${imgs} <img> without alt`)]);
  const unl = a11y.reduce((n, x) => n + x.e.a11y.inputsWithoutLabel, 0);
  if (unl) add("accessibility", "medium", `${unl} form control(s) without an accessible label`, "No <label>, aria-label, aria-labelledby or title.", [ev("html-scan", a11y.find((x) => x.e.a11y.inputsWithoutLabel)!.p.url, `${unl} unlabeled controls`)]);
  const noH1: string[] = [];
  const multiH1: string[] = [];
  const skipped: string[] = [];
  for (const { p, e } of a11y) {
    const path = new URL(p.url).pathname || "/";
    const h1 = e.headings.filter((h) => h.level === 1).length;
    if (h1 === 0) noH1.push(path);
    else if (h1 > 1) multiH1.push(path);
    let prev = 0;
    for (const h of e.headings) {
      if (prev && h.level > prev + 1) { skipped.push(`${path} (h${prev}→h${h.level})`); break; }
      prev = h.level;
    }
  }
  const group = (area: Finding["area"], sev: Finding["severity"], title: string, detail: string, pages: string[], src: string) => {
    if (pages.length) add(area, sev, `${pages.length} page(s): ${title}`, `${detail}\n${pages.slice(0, 12).join("\n")}${pages.length > 12 ? `\n… and ${pages.length - 12} more` : ""}`.trim(), [ev("html-scan", src, `${title} on ${pages.length} page(s)`)]);
  };
  const src0 = first?.url ?? "";
  group("accessibility", "low", "no <h1> heading", "Pages should expose exactly one top-level heading.", noH1, src0);
  group("accessibility", "low", "more than one <h1>", "Pages should expose exactly one top-level heading.", multiH1, src0);
  group("accessibility", "info", "heading levels skipped", "Skipped levels make outline navigation harder.", skipped, src0);

  /* ---------- SEO (grouped by issue) ---------- */
  const seo: Record<string, string[]> = {};
  for (const { p, e } of a11y) {
    const path = new URL(p.url).pathname || "/";
    if (!e.title) (seo["missing <title>"] ??= []).push(path);
    if (!e.meta["description"]) (seo["missing meta description"] ??= []).push(path);
    if (!e.meta["viewport"]) (seo["missing viewport meta (not mobile-friendly)"] ??= []).push(path);
    if (!e.meta["link:canonical"]) (seo["no canonical link"] ??= []).push(path);
    if (/noindex/i.test(e.meta["robots"] ?? "")) (seo["marked noindex"] ??= []).push(path);
  }
  for (const [issue, pages] of Object.entries(seo)) group("seo", "info", issue, "", pages, src0);

  /* ---------- Architecture ---------- */
  if (f.limits.maxPagesHit) add("architecture", "info", "Crawl stopped at the page limit", `${f.limits.queueRemaining} discovered URL(s) were not visited. Raise “Max pages” for fuller coverage.`, [ev("crawl-limit", "crawler", "maxPages reached")]);
  if (f.failedFetches.length) add("quality", "info", `${f.failedFetches.length} request(s) failed`, f.failedFetches.slice(0, 8).map((x) => `${x.url} — ${x.reason}`).join("\n"), [ev("fetch-error", f.failedFetches[0]!.url, f.failedFetches[0]!.reason)]);
  if (f.blockedByRobots.length) add("quality", "info", `${f.blockedByRobots.length} URL(s) skipped because robots.txt disallows them`, f.blockedByRobots.slice(0, 8).join("\n"), [ev("robots", f.blockedByRobots[0]!, "Disallowed by robots.txt — not fetched")]);

  const order = { high: 0, medium: 1, low: 2, info: 3 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { findings, evidence };
}
