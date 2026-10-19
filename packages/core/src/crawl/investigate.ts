/**
 * The investigation pipeline: scoped crawl → asset analysis → source-map
 * recovery → fingerprinting → features/findings/coverage/graph.
 *
 * Runs unchanged in Node (Vercel functions, desktop sidecar) because all I/O
 * goes through injected `fetch`/`resolver`/`renderer` hooks.
 */
import { DEFAULT_CRAWL } from "../schema.js";
import type { Asset, AssetKind, CrawlConfig, Endpoint, Evidence, Investigation, LogEntry, Page, SourceFile, Technology } from "../schema.js";
import { BlockedUrlError, validateUrl, type Resolver } from "../net/ssrf.js";
import { safeFetch, type FetchLike, type SafeResponse } from "../net/fetch.js";
import { hashStr, now, pool, sha256, sleep, truncate, uid, uniq } from "../util/index.js";
import { extractCssUrls, extractDesignTokens, extractPage, type ExtractedPage } from "../analyze/html.js";
import { analyzeSourceTree } from "../analyze/source.js";
import { analyzeJs, type JsAnalysis } from "../analyze/js.js";
import { fingerprint, mergeTechnologies } from "../analyze/fingerprint.js";
import { detectLibraries, type DetectedLibrary, type RetireRepository } from "../analyze/retire.js";
import { decodeInlineSourceMap, parseSourceMap } from "../analyze/sourcemap.js";
import { depsFromCdnUrls } from "../analyze/deps.js";
import { findSecretLikeValues, redactForStorage } from "../util/redact.js";
import { htmlToMarkdown } from "../analyze/markdown.js";
import { inferFeatures } from "../analyze/features.js";
import { deriveFindings } from "../analyze/findings.js";
import { computeCoverage } from "../analyze/coverage.js";
import { deobfuscateScripts, type Deobfuscator } from "../analyze/deobfuscate.js";
import { buildGraph } from "../analyze/graph.js";
import type { Facts } from "../analyze/facts.js";
import { parseRobots, type RobotsRules } from "./robots.js";
import { parseSitemap } from "./sitemap.js";

/** Optional headless-browser hook (implemented by the desktop app / local worker). */
export interface Renderer {
  render(url: string, o: { signal?: AbortSignal; interact: boolean; scopeCheck: (u: string) => boolean }): Promise<RenderResult>;
}
export interface RenderResult {
  html: string;
  finalUrl: string;
  requests: { url: string; method: string; resourceType: string; status?: number }[];
  consoleErrors: string[];
  interactions: { action: string; target: string; effect: string }[];
  screenshot?: string; // data URL (png)
  title?: string;
}

export interface InvestigateOptions {
  name?: string;
  targets: string[];
  config?: Partial<CrawlConfig>;
  fetch?: FetchLike;
  resolver?: Resolver;
  dispatcher?: unknown;
  /** Allow loopback/private destinations (desktop local mode, tests). */
  allowPrivate?: boolean;
  signal?: AbortSignal;
  renderer?: Renderer;
  /** Optional sandboxed deobfuscation engine (desktop / local worker). Used only when `config.deobfuscate` is on. */
  deobfuscator?: Deobfuscator;
  /** retire.js repository (parsed with `parseRepository`) used to identify library versions and their known vulnerabilities; omitted = step skipped. */
  retire?: RetireRepository;
  onUpdate?: (inv: Investigation) => void;
  /** Extra data retained for the UI (screenshots, rendered interactions). */
  onArtifact?: (a: { kind: "screenshot" | "interactions"; url: string; data: unknown }) => void;
}

const HTML_RE = /html|xhtml/i;

/** Path template for crawl fairness: ids/numbers/hashes collapse, and pages below a shared parent count as one template. */
export function urlTemplate(url: string): string {
  let u: URL; try { u = new URL(url); } catch { return url; }
  const segs = u.pathname.split("/").filter(Boolean).map((s) => (/^\d+$|^[0-9a-f]{8,}$|^[0-9a-f-]{32,36}$|\d{3,}/i.test(s) ? ":id" : s));
  if (segs.length >= 2) segs[segs.length - 1] = "*";
  return `${u.host}/${segs.join("/")}`;
}
const NON_PAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|map|json|xml|txt|woff2?|ttf|otf|eot|mp[34]|webm|mov|zip|gz|tgz|pdf|wasm|exe|dmg|apk|ipa|csv)(?:[?#]|$)/i;

function assetKindFor(url: string, hint?: AssetKind): AssetKind {
  if (hint) return hint;
  const p = url.split(/[?#]/)[0]!.toLowerCase();
  if (/\.(?:m?js|cjs)$/.test(p)) return "script";
  if (p.endsWith(".css")) return "style";
  if (/\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(p)) return "image";
  if (/\.(?:woff2?|ttf|otf|eot)$/.test(p)) return "font";
  if (/\.(?:mp[34]|webm|mov|ogg|wav)$/.test(p)) return "media";
  if (p.endsWith(".map")) return "sourcemap";
  if (p.endsWith(".wasm")) return "wasm";
  if (/manifest\.json$|\.webmanifest$/.test(p)) return "manifest";
  if (/\.(?:pdf|zip|gz|tgz|csv|xml|txt)$/.test(p)) return "document";
  return "other";
}

const stripHash = (u: string) => {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.toString();
  } catch {
    return u;
  }
};

export async function investigate(opts: InvestigateOptions): Promise<Investigation> {
  const cfg: CrawlConfig = { ...DEFAULT_CRAWL, ...opts.config };
  const startedAt = now();
  const log: LogEntry[] = [];
  const evidence: Evidence[] = [];
  const addEv = (e: Omit<Evidence, "id" | "timestamp">): string => {
    const id = uid("ev");
    if (evidence.length < 6000) evidence.push({ id, timestamp: now(), ...e });
    return id;
  };
  const say = (level: LogEntry["level"], msg: string) => {
    if (log.length < 600) log.push({ t: now(), level, msg });
  };

  const inv: Investigation = {
    id: uid("inv"),
    name: opts.name ?? new URL(opts.targets[0] ?? "http://unknown").host,
    targets: opts.targets.map((value) => ({ id: uid("tg"), kind: opts.targets.length > 1 ? "urls" : "url", value, addedAt: now() })),
    config: cfg,
    status: "running",
    startedAt,
    progress: 0,
    pages: [],
    assets: [],
    technologies: [],
    files: [],
    dependencies: [],
    endpoints: [],
    features: [],
    findings: [],
    evidence,
    graph: { nodes: [], edges: [] },
    coverage: { score: 0, checks: [] },
    limitations: [],
    questions: [],
    log,
  };

  let lastEmit = 0;
  const emit = (force = false) => {
    const t = Date.now();
    if (!force && t - lastEmit < 250) return;
    lastEmit = t;
    inv.pages = pages;
    inv.assets = [...assets.values()];
    inv.evidence = evidence;
    opts.onUpdate?.({ ...inv });
  };

  /* ---------- state ---------- */
  const pages: Page[] = [];
  const assets = new Map<string, Asset>();
  const extracted = new Map<string, ExtractedPage>();
  const headersByUrl = new Map<string, Record<string, string>>();
  const cookies: Facts["cookies"] = [];
  const assetBytes = new Map<string, number>();
  const jsFacts = new Map<string, JsAnalysis>();
  const jsText = new Map<string, string>(); // retained for fingerprinting
  const cssText = new Map<string, string>();
  const processedAssets = new Set<string>();
  const files: SourceFile[] = [];
  const sourceMaps: Facts["sourceMaps"] = [];
  const manifests: Facts["manifests"] = [];
  const serviceWorkers = new Set<string>();
  const secretLike: Facts["secretLikeInAssets"] = [];
  const robotsInfo: Facts["robots"] = [];
  const blockedByRobots: string[] = [];
  const failed: Facts["failedFetches"] = [];
  const endpoints = new Map<string, Endpoint>();
  const bundleRoutes = new Map<string, { origin: string; depth: number; from: string }>();
  const seen = new Set<string>();
  const claimed = new Set<string>(); // final URLs already fetched/in flight (redirect de-dup)
  const queue: { url: string; depth: number; from?: string; via: Page["discoveredVia"] }[] = [];
  let scheduled = 0;
  // Page-budget fairness: many URLs of one template (/products/:slug, /blog/2024/…) must not use up maxPages before
  // distinct pages (/pricing, /login, /docs) are reached. Over-quota URLs wait in `deferred` and fill whatever budget is left.
  const perTemplate = new Map<string, number>();
  const deferred: typeof queue = [];
  const templateQuota = Math.max(4, Math.ceil(cfg.maxPages * 0.15));
  let sitemapUrls = 0;
  let maxPagesHit = false;
  let maxDepthHit = false;
  let assetsOverLimit = 0;
  let rendered = false;
  let retainedBytes = 0;
  let totalBytes = 0;
  const RETAIN_CAP = 60_000_000;

  const seedHosts = new Set<string>();
  const selectedUrls = new Set<string>();
  for (const t of opts.targets) {
    const u = validateUrl(t, { allowPrivate: opts.allowPrivate }); // throws BlockedUrlError for hostile seeds
    seedHosts.add(u.hostname.toLowerCase());
    selectedUrls.add(stripHash(u.toString()));
  }
  for (const h of cfg.allowedHosts) seedHosts.add(h.toLowerCase());

  const inScope = (raw: string): boolean => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    const h = u.hostname.toLowerCase();
    if (seedHosts.has(h)) return true;
    if (cfg.includeSubdomains) for (const s of seedHosts) if (h.endsWith("." + s.replace(/^www\./, ""))) return true;
    // www ↔ apex of the same site is the same site
    for (const s of seedHosts) if (h.replace(/^www\./, "") === s.replace(/^www\./, "")) return true;
    return false;
  };

  /* ---------- fetch plumbing ---------- */
  const hostNext = new Map<string, number>();
  const robotsCache = new Map<string, Promise<RobotsRules | null>>();

  const throttle = async (host: string, extraDelay = 0) => {
    const delay = Math.max(cfg.delayMs, extraDelay);
    const t = Date.now();
    const next = hostNext.get(host) ?? 0;
    hostNext.set(host, Math.max(t, next) + delay);
    if (next > t) await sleep(next - t, opts.signal);
  };

  const rawFetch = (url: string, o: { maxBytes: number; method?: string; accept?: string; scoped?: boolean }): Promise<SafeResponse> =>
    safeFetch(url, {
      fetch: opts.fetch,
      resolver: opts.resolver,
      dispatcher: opts.dispatcher,
      allowPrivate: opts.allowPrivate,
      maxBytes: o.maxBytes,
      method: o.method,
      signal: opts.signal,
      timeoutMs: 20_000,
      headers: { "user-agent": cfg.userAgent, accept: o.accept ?? "*/*", "accept-language": "en-US,en;q=0.9" },
      beforeHop: o.scoped ? (u) => { if (!inScope(u.toString())) throw new BlockedUrlError(`Redirect left the permitted scope: ${u.host}`, "scope"); } : undefined,
    });

  const getRobots = (origin: string): Promise<RobotsRules | null> => {
    if (!cfg.respectRobots) return Promise.resolve(null);
    let p = robotsCache.get(origin);
    if (!p) {
      p = (async () => {
        const host = new URL(origin).host;
        try {
          await throttle(host);
          const r = await rawFetch(`${origin}/robots.txt`, { maxBytes: 500_000, accept: "text/plain" });
          if (r.status !== 200) {
            robotsInfo.push({ host, found: false, disallowed: 0, sitemaps: [] });
            return null;
          }
          const rules = parseRobots(r.text(), cfg.userAgent);
          robotsInfo.push({ host, found: true, disallowed: (r.text().match(/^\s*disallow:\s*\S/gim) ?? []).length, sitemaps: rules.sitemaps });
          addEv({ kind: "observed", method: "http-get", source: `${origin}/robots.txt`, hash: await sha256(r.body), confidence: 1, summary: `robots.txt retrieved (${rules.sitemaps.length} sitemap(s))` });
          return rules;
        } catch (e) {
          say("warn", `robots.txt unavailable for ${host}: ${(e as Error).message}`);
          robotsInfo.push({ host, found: false, disallowed: 0, sitemaps: [] });
          return null;
        }
      })();
      robotsCache.set(origin, p);
    }
    return p;
  };

  const allowedByRobots = async (url: string): Promise<boolean> => {
    if (!cfg.respectRobots) return true;
    const u = new URL(url);
    const rules = await getRobots(u.origin);
    if (!rules) return true;
    return rules.allow(u.pathname + u.search);
  };

  const registerAsset = (url: string, kind: AssetKind | undefined, referencedBy: string): Asset | null => {
    const clean = stripHash(url);
    if (!/^https?:/i.test(clean)) return null;
    let a = assets.get(clean);
    if (!a) {
      a = { id: `as_${hashStr(clean).slice(0, 10)}`, url: clean, kind: assetKindFor(clean, kind), fetched: false, referencedBy: [] };
      assets.set(clean, a);
    }
    if (!a.referencedBy.includes(referencedBy) && a.referencedBy.length < 50) a.referencedBy.push(referencedBy);
    return a;
  };

  const enqueue = (url: string, depth: number, via: Page["discoveredVia"], from?: string): boolean => {
    const clean = stripHash(url);
    if (seen.has(clean) || !inScope(clean) || NON_PAGE_EXT.test(clean)) return false;
    if (scheduled >= cfg.maxPages) {
      maxPagesHit = true;
      return false;
    }
    try {
      validateUrl(clean, { allowPrivate: opts.allowPrivate });
    } catch {
      return false;
    }
    const tk = urlTemplate(clean); const n = perTemplate.get(tk) ?? 0;
    if (via !== "seed" && n >= templateQuota) {
      if (deferred.length >= cfg.maxPages * 4) { maxPagesHit = true; return false; }
      seen.add(clean); deferred.push({ url: clean, depth, from, via }); return true;
    }
    seen.add(clean);
    perTemplate.set(tk, n + 1);
    scheduled++;
    queue.push({ url: clean, depth, from, via });
    return true;
  };
  /** Called when the queue runs dry: spend leftover page budget on deferred same-template URLs, in discovery order. */
  const releaseDeferred = () => {
    let moved = 0;
    while (deferred.length && scheduled < cfg.maxPages) { queue.push(deferred.shift()!); scheduled++; moved++; }
    if (deferred.length) maxPagesHit = true;
    return moved;
  };

  /* ---------- page processing ---------- */
  const processPage = async (job: (typeof queue)[number]) => {
    if (claimed.has(job.url)) return;
    claimed.add(job.url);
    const u = new URL(job.url);
    if (!(await allowedByRobots(job.url))) {
      blockedByRobots.push(job.url);
      return;
    }
    const rules = await getRobots(u.origin);
    await throttle(u.host, (rules?.crawlDelay ?? 0) * 1000);
    let res: SafeResponse;
    try {
      res = await rawFetch(job.url, { maxBytes: 4_000_000, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", scoped: true });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      failed.push({ url: job.url, reason: (e as Error).message });
      say("warn", `Fetch failed: ${job.url} — ${(e as Error).message}`);
      return;
    }
    totalBytes += res.body.byteLength;
    const finalUrl = stripHash(res.url);
    if (finalUrl !== job.url) {
      if (claimed.has(finalUrl)) return; // redirect target already fetched (or being fetched)
      claimed.add(finalUrl);
      seen.add(finalUrl);
      if (!inScope(finalUrl)) return;
    }
    if (job.via === "bundle-route" && res.status >= 400) {
      say("info", `Route string ${job.url} referenced by a bundle does not resolve (HTTP ${res.status}); not recorded as a page`);
      return;
    }
    const contentType = res.headers["content-type"] ?? "";
    headersByUrl.set(finalUrl, res.headers);
    for (const c of res.cookies) cookies.push({ ...c, url: finalUrl });
    const hash = await sha256(res.body);
    const pageId = `pg_${hashStr(finalUrl).slice(0, 10)}`;
    const base: Page = {
      id: pageId, url: finalUrl, status: res.status, title: "", depth: job.depth, contentType, bytes: res.body.byteLength, hash, ms: res.ms,
      discoveredFrom: job.from, discoveredVia: job.via, links: [], scripts: [], styles: [], images: [], forms: [], headings: [], landmarks: [], meta: {},
      interactive: { buttons: 0, inputs: 0, dialogs: 0, links: 0 }, a11y: { imagesWithoutAlt: 0, inputsWithoutLabel: 0, hasLang: false, hasMain: false },
    };
    addEv({ kind: "observed", method: "http-get", source: finalUrl, hash, confidence: 1, summary: `GET ${finalUrl} → ${res.status} ${contentType.split(";")[0]} (${res.body.byteLength} B, ${res.ms} ms)`, related: [pageId] });
    if (!HTML_RE.test(contentType) && !/^\s*</.test(res.text().slice(0, 200))) {
      base.error = `Non-HTML content (${contentType || "unknown"})`;
      pages.push(base);
      return;
    }
    let html = res.text();
    let ex = extractPage(html, finalUrl);

    if (cfg.render && opts.renderer) {
      try {
        const r = await opts.renderer.render(finalUrl, { signal: opts.signal, interact: true, scopeCheck: inScope });
        rendered = true;
        const exr = extractPage(r.html, finalUrl);
        // union static + rendered structure; rendered DOM is the primary view
        ex = { ...exr, links: uniq([...ex.links, ...exr.links]), scripts: uniq([...ex.scripts, ...exr.scripts]), styles: uniq([...ex.styles, ...exr.styles]), images: uniq([...ex.images, ...exr.images]), inlineScripts: ex.inlineScripts };
        html = r.html;
        addEv({ kind: "dynamic", method: "headless-render", source: finalUrl, confidence: 0.95, summary: `Rendered DOM captured (${r.html.length} chars, ${r.requests.length} network requests, ${r.interactions.length} interactions)`, related: [pageId] });
        for (const rq of r.requests) {
          if (/^(?:xhr|fetch|eventsource|websocket)$/i.test(rq.resourceType)) {
            const key = `${rq.method} ${rq.url}`;
            if (!endpoints.has(key)) endpoints.set(key, { url: rq.url, method: rq.method, kind: rq.resourceType === "websocket" ? "websocket" : rq.resourceType === "eventsource" ? "sse" : /graphql/i.test(rq.url) ? "graphql" : "rest", foundIn: finalUrl, evidence: addEv({ kind: "dynamic", method: "network-observe", source: finalUrl, confidence: 1, summary: `Observed ${rq.method} ${rq.url}${rq.status ? ` → ${rq.status}` : ""}`, related: [pageId] }) });
          }
          if (/^(?:script|stylesheet|font|image)$/i.test(rq.resourceType)) registerAsset(rq.url, rq.resourceType === "stylesheet" ? "style" : (rq.resourceType as AssetKind), finalUrl);
        }
        for (const ce of r.consoleErrors.slice(0, 5)) say("warn", `Console error on ${finalUrl}: ${truncate(ce, 160)}`);
        if (r.screenshot) opts.onArtifact?.({ kind: "screenshot", url: finalUrl, data: r.screenshot });
        if (r.interactions.length) opts.onArtifact?.({ kind: "interactions", url: finalUrl, data: r.interactions });
      } catch (e) {
        say("warn", `Render failed for ${finalUrl}: ${(e as Error).message}`);
      }
    }

    extracted.set(finalUrl, ex);
    Object.assign(base, {
      title: ex.title, links: ex.links, scripts: ex.scripts, styles: ex.styles, images: ex.images, forms: ex.forms, headings: ex.headings,
      landmarks: ex.landmarks, meta: ex.meta, interactive: ex.interactive, a11y: ex.a11y,
    });
    try { const m = htmlToMarkdown(html, finalUrl, { maxChars: 6000 }); if (m.text) { base.text = redactForStorage("page.md", m.text).text; if (m.truncated) base.textTruncated = true; } } catch { /* page text is a bonus; structure above is already recorded */ }
    pages.push(base);

    for (const s of ex.scripts) registerAsset(s, "script", finalUrl);
    for (const s of ex.styles) registerAsset(s, "style", finalUrl);
    for (const s of ex.images) registerAsset(s, "image", finalUrl);
    for (const s of ex.fonts) registerAsset(s, "font", finalUrl);
    for (const s of ex.media) registerAsset(s, "media", finalUrl);
    if (ex.manifest) registerAsset(ex.manifest, "manifest", finalUrl);
    for (const l of ex.links) if (NON_PAGE_EXT.test(l) && inScope(l)) registerAsset(l, "document", finalUrl);

    // inline scripts: analyse for endpoints/routes (data blobs skipped)
    ex.inlineScripts.slice(0, 20).forEach((code, i) => {
      const c = code.trim();
      if (!c || c.length > 300_000 || /^[{[<]/.test(c)) return;
      const key = `${finalUrl}#inline-${i}`;
      const a = analyzeJs(c, { maxAstBytes: 300_000 });
      jsFacts.set(key, a);
      if (retainedBytes + c.length < RETAIN_CAP) {
        jsText.set(key, c);
        retainedBytes += c.length;
      }
    });

    // enqueue discovered pages
    if (cfg.mode === "domain" || cfg.mode === "multi") {
      if (job.depth >= cfg.maxDepth) {
        if (ex.links.some((l) => inScope(l) && !seen.has(stripHash(l)) && !NON_PAGE_EXT.test(l))) maxDepthHit = true;
      } else for (const l of ex.links) enqueue(l, job.depth + 1, "link", finalUrl);
    }
    // sitemap-style discovery is done once, up-front
    emit();
  };

  const crawlQueue = async () => {
    let inflight = 0;
    const worker = async () => {
      while (!opts.signal?.aborted) {
        const job = queue.shift();
        if (!job) {
          if (inflight === 0 && !releaseDeferred()) return;
          await sleep(20, opts.signal).catch(() => {});
          continue;
        }
        inflight++;
        try {
          await processPage(job);
        } catch (e) {
          if (opts.signal?.aborted) return;
          failed.push({ url: job.url, reason: (e as Error).message });
          say("error", `Unexpected error on ${job.url}: ${(e as Error).message}`);
        } finally {
          inflight--;
          inv.progress = Math.min(0.55, (pages.length + failed.length) / Math.max(scheduled, 1) * 0.55);
          emit();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(cfg.concurrency, 16)) }, worker));
  };

  /* ---------- asset processing ---------- */
  const fetchAsset = async (a: Asset): Promise<SafeResponse | null> => {
    const sameSite = inScope(a.url);
    if (!sameSite && !cfg.inspectExternal) {
      a.skippedReason = "third-party (enable “inspect external dependencies” to fetch)";
      return null;
    }
    try {
      const u = new URL(a.url);
      if (cfg.respectRobots && sameSite && !(await allowedByRobots(a.url))) {
        a.skippedReason = "disallowed by robots.txt";
        blockedByRobots.push(a.url);
        return null;
      }
      await throttle(u.host);
      const res = await rawFetch(a.url, { maxBytes: cfg.maxAssetBytes, scoped: false });
      totalBytes += res.body.byteLength;
      a.status = res.status;
      a.bytes = res.body.byteLength;
      a.contentType = res.headers["content-type"];
      a.fetched = res.status >= 200 && res.status < 300;
      headersByUrl.set(a.url, res.headers);
      if (res.truncated) {
        assetsOverLimit++;
        a.skippedReason = `larger than ${cfg.maxAssetBytes} bytes; analysed first ${cfg.maxAssetBytes} bytes only`;
      }
      if (!a.fetched) {
        a.skippedReason = `HTTP ${res.status}`;
        return null;
      }
      a.hash = await sha256(res.body);
      assetBytes.set(a.url, res.body.byteLength);
      addEv({ kind: "observed", method: "http-get", source: a.url, hash: a.hash, confidence: 1, summary: `GET ${a.url} → ${res.status} (${res.body.byteLength} B)`, related: [a.id] });
      return res;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      a.skippedReason = (e as Error).message;
      failed.push({ url: a.url, reason: (e as Error).message });
      return null;
    }
  };

  const handleScript = async (a: Asset, res: SafeResponse) => {
    const code = res.text();
    const analysis = analyzeJs(code, { maxAstBytes: 1_500_000 });
    jsFacts.set(a.url, analysis);
    if (retainedBytes + code.length < RETAIN_CAP) {
      jsText.set(a.url, code);
      retainedBytes += code.length;
    }
    const kinds = findSecretLikeValues(code.slice(0, 1_500_000)).filter((k) => !["jwt", "bearer", "assignment"].includes(k) || /private-key|aws|github|stripe|anthropic|slack/.test(k));
    const realKinds = kinds.filter((k) => !["openai-key"].includes(k) || /sk-(?:proj-)?[A-Za-z0-9_-]{40,}/.test(code));
    if (realKinds.length) secretLike.push({ url: a.url, kinds: realKinds });
    addEv({ kind: "reconstructed", method: analysis.method === "ast" ? "acorn-ast" : "lexical-scan", source: a.url, hash: a.hash, confidence: analysis.method === "ast" ? 0.9 : 0.6, summary: `${analysis.imports.length} imports, ${analysis.components.length} components, ${analysis.endpoints.length} endpoints, ${analysis.routes.length} route strings${analysis.minified ? " (minified)" : ""}`, related: [a.id] });

    for (const ep of analysis.endpoints) {
      const abs = (() => { try { return new URL(ep.url, a.referencedBy[0] ?? a.url).toString(); } catch { return ep.url; } })();
      const kind: Endpoint["kind"] = ep.via === "WebSocket" || /^wss?:/i.test(ep.url) ? "websocket" : ep.via === "EventSource" ? "sse" : /graphql/i.test(ep.url) ? "graphql" : "rest";
      const key = `${ep.method ?? ""} ${abs}`;
      if (!endpoints.has(key)) endpoints.set(key, { url: abs, method: ep.method, kind, foundIn: a.url, evidence: addEv({ kind: "reconstructed", method: "js-ast", source: a.url, confidence: 0.8, summary: `${kind} endpoint ${abs}${ep.method ? ` (${ep.method})` : ""} referenced via ${ep.via}`, related: [a.id] }) });
    }
    for (const r of analysis.routes) {
      const ref = a.referencedBy[0];
      const page = ref ? pages.find((p) => p.url === ref) : pages[0];
      if (page) bundleRoutes.set(new URL(r, page.url).toString(), { origin: new URL(page.url).origin, depth: page.depth + 1, from: a.url });
    }
    const sw = code.match(/serviceWorker\.register\(\s*["'`]([^"'`]+)["'`]/);
    if (sw) {
      try {
        const swUrl = new URL(sw[1]!, a.referencedBy[0] ?? a.url).toString();
        serviceWorkers.add(swUrl);
        registerAsset(swUrl, "worker", a.url);
      } catch { /* ignore */ }
    }
    for (const m of code.matchAll(/["'`]([^"'`\s]{3,200}\.wasm)["'`]/g)) {
      try { registerAsset(new URL(m[1]!, a.url).toString(), "wasm", a.url); } catch { /* ignore */ }
    }

    // source map: only follow what the bundle itself declares
    const declared = analysis.sourceMappingURL ?? res.headers["sourcemap"] ?? res.headers["x-sourcemap"];
    if (declared) {
      let mapJson: string | null = null;
      let mapUrl = a.url + " (inline)";
      if (declared.startsWith("data:")) mapJson = decodeInlineSourceMap(declared);
      else {
        try {
          mapUrl = new URL(declared, a.url).toString();
          const ma = registerAsset(mapUrl, "sourcemap", a.url)!;
          if (inScope(mapUrl) || cfg.inspectExternal) {
            const mr = await fetchAsset(ma);
            if (mr) mapJson = mr.text();
          } else ma.skippedReason = "third-party source map not fetched";
        } catch { /* ignore */ }
      }
      if (mapJson) {
        const parsed = await parseSourceMap(mapJson, mapUrl);
        sourceMaps.push({ url: mapUrl, ok: parsed.ok, recovered: parsed.recovered, total: parsed.totalSources, withoutContent: parsed.withoutContent });
        if (parsed.ok) {
          files.push(...parsed.files);
          a.sourceMapUrl = mapUrl;
          addEv({ kind: parsed.recovered ? "recovered" : "reconstructed", method: "sourcemap", source: mapUrl, confidence: parsed.recovered ? 1 : 0.7, summary: parsed.recovered ? `Recovered ${parsed.recovered} original source file(s) verbatim from sourcesContent (${parsed.vendored} vendored skipped)` : `Source map lists ${parsed.totalSources} source path(s) but ships no sourcesContent — structure only`, related: [a.id] });
        } else say("warn", `Source map ${mapUrl} could not be parsed: ${parsed.error}`);
      }
    }
  };

  const handleCss = async (a: Asset, res: SafeResponse) => {
    const css = res.text();
    if (retainedBytes + css.length < RETAIN_CAP) {
      cssText.set(a.url, css);
      retainedBytes += css.length;
    }
    for (const u of extractCssUrls(css, a.url)) registerAsset(u, undefined, a.url);
  };

  const handleManifest = async (a: Asset, res: SafeResponse) => {
    try {
      const m = JSON.parse(res.text());
      manifests.push({ url: a.url, name: m.name ?? m.short_name, display: m.display, startUrl: m.start_url, icons: Array.isArray(m.icons) ? m.icons.length : 0 });
    } catch {
      say("warn", `Manifest ${a.url} is not valid JSON`);
    }
  };

  const processAssets = async () => {
    if (!cfg.fetchAssets) return;
    for (let round = 0; round < 4; round++) {
      const todo = [...assets.values()].filter((a) => !processedAssets.has(a.url) && ["script", "style", "manifest", "worker", "sourcemap"].includes(a.kind));
      if (!todo.length) break;
      await pool(todo, Math.min(cfg.concurrency, 8), async (a) => {
        processedAssets.add(a.url);
        if (a.kind === "sourcemap") return; // fetched only via the script that declares it
        const res = await fetchAsset(a);
        if (!res) return;
        if (a.kind === "script" || a.kind === "worker") await handleScript(a, res);
        else if (a.kind === "style") await handleCss(a, res);
        else if (a.kind === "manifest") await handleManifest(a, res);
        inv.progress = Math.min(0.8, 0.55 + (processedAssets.size / Math.max(assets.size, 1)) * 0.25);
        emit();
      });
    }
    // sizes for the remaining same-site assets (images/fonts/media) via HEAD — bounded
    const heads = [...assets.values()].filter((a) => !a.fetched && a.bytes === undefined && inScope(a.url) && ["image", "font", "media", "wasm", "document"].includes(a.kind)).slice(0, 120);
    await pool(heads, Math.min(cfg.concurrency, 6), async (a) => {
      try {
        await throttle(new URL(a.url).host);
        const r = await rawFetch(a.url, { maxBytes: 1, method: "HEAD" });
        a.status = r.status;
        a.contentType = r.headers["content-type"];
        const len = Number(r.headers["content-length"]);
        if (Number.isFinite(len)) a.bytes = len;
        headersByUrl.set(a.url, r.headers);
      } catch { /* sizes are best-effort; unknown stays unknown */ }
    });
  };

  /* ---------- run ---------- */
  try {
    say("info", `Starting analysis of ${opts.targets.join(", ")} (${cfg.mode}, depth ${cfg.maxDepth}, ≤${cfg.maxPages} pages)`);
    // seeds
    const seedList = cfg.mode === "single" ? opts.targets.slice(0, 1) : opts.targets;
    for (const t of seedList) enqueue(t, 0, "seed");
    if (cfg.mode === "selected" || cfg.mode === "single") {
      /* no link following */
    }
    // sitemaps (declared in robots.txt or at /sitemap.xml) seed extra pages
    if (cfg.followSitemaps && (cfg.mode === "domain" || cfg.mode === "multi")) {
      const origins = uniq(opts.targets.map((t) => new URL(t).origin));
      for (const origin of origins) {
        const rules = await getRobots(origin);
        const candidates = uniq([...(rules?.sitemaps ?? []), `${origin}/sitemap.xml`]);
        const todo = candidates.map((c) => ({ url: c, level: 0 }));
        let fetchedSitemaps = 0;
        while (todo.length && fetchedSitemaps < 8) {
          const { url, level } = todo.shift()!;
          try {
            if (!inScope(url)) continue;
            await throttle(new URL(url).host);
            const r = await rawFetch(url, { maxBytes: 3_000_000, scoped: true });
            if (r.status !== 200) continue;
            fetchedSitemaps++;
            const sm = parseSitemap(r.text());
            sitemapUrls += sm.urls.length;
            addEv({ kind: "observed", method: "http-get", source: url, hash: await sha256(r.body), confidence: 1, summary: `Sitemap: ${sm.urls.length} URL(s), ${sm.sitemaps.length} child sitemap(s)` });
            for (const s of sm.sitemaps) if (level < 2) todo.push({ url: s, level: level + 1 });
            for (const u of sm.urls.slice(0, 500)) enqueue(u, 1, "sitemap", url);
          } catch (e) {
            if (opts.signal?.aborted) throw e;
          }
        }
      }
    }

    await crawlQueue();
    inv.progress = 0.55;
    emit(true);
    await processAssets();

    // second pass: routes referenced in same-site bundles that no link led to
    if ((cfg.mode === "domain" || cfg.mode === "multi") && bundleRoutes.size && !opts.signal?.aborted) {
      let added = 0;
      for (const [url, meta] of bundleRoutes) {
        if (added >= 40) break;
        if (!url.startsWith(meta.origin) || meta.depth > cfg.maxDepth + 1) continue;
        if (enqueue(url, Math.min(meta.depth, cfg.maxDepth), "bundle-route", meta.from)) added++;
      }
      if (added) {
        say("info", `Probing ${added} route(s) referenced by JavaScript bundles`);
        const before = pages.length;
        await crawlQueue();
        await processAssets();
        say("info", `${pages.filter((p) => p.discoveredVia === "bundle-route" && p.status < 400).length} bundle-referenced route(s) resolved to real pages (${pages.length - before} fetched)`);
      }
    }
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");

    /* ---------- analysis ---------- */
    inv.progress = 0.82;
    say("info", "Fingerprinting technologies");
    const okPages = pages.filter((p) => extracted.has(p.url));
    const techLists: Technology[][] = [];
    for (const p of okPages.slice(0, 12)) {
      const ex = extracted.get(p.url)!;
      const fp = fingerprint({ url: p.url, headers: headersByUrl.get(p.url) ?? {}, html: ex.html, scriptUrls: ex.scripts, scripts: [], css: [], cssUrls: ex.styles, meta: ex.meta, cookies: cookies.filter((c) => c.url === p.url).map((c) => c.name) });
      techLists.push(fp.technologies);
      evidence.push(...fp.evidence);
    }
    {
      const allScriptUrls = [...assets.values()].filter((a) => a.kind === "script").map((a) => a.url);
      const allCssUrls = [...assets.values()].filter((a) => a.kind === "style" || a.kind === "font").map((a) => a.url);
      const fp = fingerprint({
        url: opts.targets[0]!, headers: {}, html: "", meta: {}, cookies: [], scriptUrls: allScriptUrls, cssUrls: allCssUrls,
        scripts: [...jsText.entries()].map(([url, content]) => ({ url, content })), css: [...cssText.entries()].map(([url, content]) => ({ url, content })),
      });
      techLists.push(fp.technologies);
      evidence.push(...fp.evidence);
      // browser APIs seen in AST facts
      void fp;
    }
    inv.technologies = mergeTechnologies(techLists);
    inv.dependencies = depsFromCdnUrls([...assets.values()].filter((a) => a.kind === "script" || a.kind === "style").map((a) => a.url));
    // Versioned library detection (retire.js rules). Runs entirely on text already collected; the host supplies the rule data.
    let libs: DetectedLibrary[] = []; const libEv = new Map<DetectedLibrary, string>();
    if (opts.retire) {
      say("info", "Identifying JavaScript library versions");
      libs = detectLibraries(opts.retire, [...assets.values()].filter((a) => a.kind === "script").map((a) => ({ url: a.url, content: jsText.get(a.url) })).concat([...jsText.entries()].filter(([k]) => k.includes("#inline-")).map(([url, content]) => ({ url, content }))));
      const libTech: Technology[] = [];
      for (const l of libs) {
        const ev = addEv({ kind: "observed", method: "retire.js", source: l.url, confidence: l.detection === "uri" ? 0.8 : 0.95, summary: `${l.component} ${l.version} identified from ${l.detection === "uri" ? "its URL" : l.detection === "filename" ? "its file name" : "its contents"}${l.vulnerabilities.length ? `; ${l.vulnerabilities.length} known advisor${l.vulnerabilities.length === 1 ? "y" : "ies"} apply to this version` : ""}` });
        libTech.push({ name: l.component, category: "JavaScript library", version: l.version, confidence: l.detection === "uri" ? 0.8 : 0.95, evidence: [ev] });
        if (!inv.dependencies.some((d) => d.name === (l.npmname ?? l.component) && d.version === l.version)) inv.dependencies.push({ name: l.npmname ?? l.component, version: l.version, ecosystem: l.npmname ? "npm" : "cdn", source: l.url, evidence: ev });
        libEv.set(l, ev);
      }
      techLists.push(libTech);
      inv.technologies = mergeTechnologies(techLists);
      inv.libraries = libs.map(({ url, ...rest }) => ({ ...rest, source: url }));
    }
    // Optional sandboxed deobfuscation. Results are RECONSTRUCTED files kept apart from `files` (recovered sources) so they are never analysed or labelled as recovered.
    const reconFiles: SourceFile[] = []; let deobf: Facts["deobfuscation"];
    if (cfg.deobfuscate && opts.deobfuscator) {
      say("info", "Deobfuscating minified or obfuscated first-party scripts in a sandbox…");
      const r = await deobfuscateScripts(jsText, opts.deobfuscator, { firstParty: inScope, signal: opts.signal });
      reconFiles.push(...r.files);
      deobf = { ...r.stats, tool: r.results.find((x) => x.out.ok)?.out.tool };
      for (const x of r.results) {
        if (!x.out.ok) { addEv({ kind: "unavailable", method: "deobfuscate", source: x.url, confidence: 1, summary: `Could not deobfuscate (${x.why}): ${x.out.error ?? x.out.notes.join("; ") ?? "no output"}` }); continue; }
        addEv({ kind: "reconstructed", method: x.out.tool, source: x.url, confidence: 0.6, summary: `Made readable (${x.why})${x.out.unpacked ? `, split into ${x.paths.length} module(s)` : ""}: ${x.paths.slice(0, 3).join(", ")}${x.paths.length > 3 ? "…" : ""}. Original names and comments are not recoverable.` });
        // readable code often reveals what string-array obfuscation hid: look for endpoints again
        const readable = x.out.modules?.length ? x.out.modules.map((m) => m.code).join("\n") : x.out.code ?? "";
        for (const ep of analyzeJs(readable.slice(0, 1_500_000), { maxAstBytes: 1_500_000 }).endpoints) {
          const abs = (() => { try { return new URL(ep.url, x.url).toString(); } catch { return ep.url; } })();
          const kind: Endpoint["kind"] = ep.via === "WebSocket" || /^wss?:/i.test(ep.url) ? "websocket" : ep.via === "EventSource" ? "sse" : /graphql/i.test(ep.url) ? "graphql" : "rest";
          const key = `${ep.method ?? ""} ${abs}`;
          if (!endpoints.has(key)) endpoints.set(key, { url: abs, method: ep.method, kind, foundIn: `${x.url} (deobfuscated)`, evidence: addEv({ kind: "reconstructed", method: `${x.out.tool}+acorn-ast`, source: x.url, confidence: 0.6, summary: `${kind} endpoint ${abs} found only after deobfuscation` }) });
        }
      }
      say("info", `Deobfuscation: ${r.stats.ok}/${r.stats.candidates} candidate script(s) made readable`);
    }
    inv.files = [...files, ...reconFiles];
    inv.endpoints = [...endpoints.values()];

    const facts: Facts = {
      pages, extracted, responseHeaders: headersByUrl, cookies, assets: [...assets.values()], assetBytes, technologies: inv.technologies,
      endpoints: inv.endpoints, js: jsFacts, css: cssText, files, sourceMaps, manifests, serviceWorkers: [...serviceWorkers], secretLikeInAssets: secretLike,
      robots: robotsInfo, sitemapUrls, blockedByRobots, failedFetches: failed, rendered, deobfuscation: deobf,
      limits: { maxPagesHit, maxDepthHit, assetsOverLimit, queueRemaining: queue.length + deferred.length },
    };
    // recovered source → first-class source analysis (components, imports, env names, deps)
    let extraGraph: Investigation["graph"] | undefined;
    const comps: NonNullable<Investigation["components"]> = [];
    for (const [url, a] of jsFacts) for (const c of a.components) comps.push({ name: c, source: url, provenance: "reconstructed" });
    if (files.length) {
      const tree = await analyzeSourceTree(files.map((f) => ({ path: f.path, data: new TextEncoder().encode(f.content ?? ""), origin: f.origin, provenance: "recovered" as const })), { includeContent: false });
      extraGraph = tree.graph;
      for (const c of tree.components) comps.push({ name: c.name, source: c.file, provenance: "recovered" });
      inv.dependencies = [...inv.dependencies, ...tree.dependencies];
      inv.envVars = tree.envVars;
      say("info", `Analysed ${files.length} recovered source file(s): ${tree.components.length} components, ${tree.graph.edges.length} import edges`);
    }
    inv.components = comps.filter((c, i, arr) => arr.findIndex((x) => x.name === c.name && x.source === c.source) === i);
    const routeMap = new Map<string, NonNullable<Investigation["routes"]>[number]>();
    for (const p of pages) routeMap.set(new URL(p.url).pathname, { route: new URL(p.url).pathname || "/", source: p.url, via: p.discoveredVia === "sitemap" ? "sitemap" : p.discoveredVia === "bundle-route" ? "bundle" : "link" });
    for (const [url, a] of jsFacts) for (const r of a.routes) if (!routeMap.has(r)) routeMap.set(r, { route: r, source: url, via: "bundle" });
    inv.routes = [...routeMap.values()].sort((a, b) => a.route.localeCompare(b.route));
    {
      const allCss = [...cssText.values()].join("\n").slice(0, 2_000_000);
      if (allCss) inv.designTokens = extractDesignTokens(allCss);
      const tp = new Map<string, { kinds: Set<string>; count: number }>();
      for (const a of assets.values()) {
        try {
          const h = new URL(a.url).hostname;
          if (inScope(a.url)) continue;
          const e = tp.get(h) ?? { kinds: new Set<string>(), count: 0 };
          e.kinds.add(a.kind);
          e.count++;
          tp.set(h, e);
        } catch { /* ignore */ }
      }
      inv.thirdParties = [...tp.entries()].map(([host, v]) => ({ host, kinds: [...v.kinds], count: v.count })).sort((a, b) => b.count - a.count);
    }
    // module graph from recovered sources
    const feat = inferFeatures(facts);
    inv.features = feat.features;
    evidence.push(...feat.evidence);
    const fnd = deriveFindings(facts);
    inv.findings = fnd.findings;
    evidence.push(...fnd.evidence);
    for (const l of libs) {
      if (!l.vulnerabilities.length) continue;
      const rank = ["unknown", "low", "medium", "high", "critical"]; const top = l.vulnerabilities.reduce((m, v) => (rank.indexOf(v.severity) > rank.indexOf(m) ? v.severity : m), "unknown" as DetectedLibrary["vulnerabilities"][number]["severity"]);
      inv.findings.push({ id: uid("fd"), area: "security", severity: top === "critical" || top === "high" ? "high" : top === "unknown" ? "info" : top, title: `Known vulnerabilities in ${l.component} ${l.version}`, evidence: [libEv.get(l)!].filter(Boolean),
        detail: `${l.vulnerabilities.length} advisor${l.vulnerabilities.length === 1 ? "y" : "ies"} in the retire.js database apply to this version (identified from ${l.detection === "uri" ? "its URL" : l.detection === "filename" ? "its file name" : "its contents"} at ${l.url}): ${l.vulnerabilities.slice(0, 4).map((v) => `${v.summary}${v.ids.length ? ` (${v.ids.slice(0, 2).join(", ")})` : ""}`).join("; ")}${l.vulnerabilities.length > 4 ? "; …" : ""}. A match means this version is in an affected range, not that the site is exploitable.` });
    }
    const cov = computeCoverage(facts, cfg);
    inv.coverage = cov.coverage;
    inv.limitations = cov.limitations;
    inv.questions = [
      ...(files.length === 0 ? ["Does the owner publish source maps or a repository? Supplying either would convert RECONSTRUCTED structure into RECOVERED source."] : []),
      ...(!rendered ? ["Run with rendering enabled (desktop app / local worker) to capture client-rendered content and runtime network calls."] : []),
      ...(inv.endpoints.length ? ["Request/response schemas for the discovered endpoints are unknown; authorised interaction recording would reveal them."] : []),
    ];
    inv.pages = pages;
    inv.assets = facts.assets;
    inv.graph = buildGraph(inv, extraGraph, facts);
    inv.status = "done";
    inv.progress = 1;
    say("info", `Done: ${pages.length} page(s), ${assets.size} asset(s), ${inv.technologies.length} technologies, ${inv.features.length} features, ${totalBytes} bytes fetched`);
  } catch (e) {
    if (opts.signal?.aborted) {
      inv.status = "cancelled";
      say("warn", "Analysis cancelled");
    } else {
      inv.status = "error";
      say("error", (e as Error).message);
      throw e;
    }
  } finally {
    inv.finishedAt = now();
    inv.pages = pages;
    inv.assets = [...assets.values()];
    emit(true);
  }
  return inv;
}
