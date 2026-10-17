/**
 * Portable request handlers (Web-standard Request → Response). The same
 * functions back the Vercel functions (hosted, strict) and the desktop
 * sidecar (local, privileged).
 */
import { analyzeSnapshot, assessRip, detectLicense, fetchRepoSnapshot, investigate, parseRepoRef, RepoRefError, effective, validateUrl, BlockedUrlError, type CrawlConfig, type FetchRepoOptions, type Investigation, type Renderer } from "@omniforge/core";
import { HttpError, bytesToB64, err, json, readJson, sse } from "./http.js";
import { nodeNet } from "./net.js";

export type Mode = "hosted" | "local";
export interface HandlerOptions {
  mode: Mode;
  /** Max wall-clock for one analysis (hosted functions have a hard ceiling). */
  maxDurationMs?: number;
  renderer?: Renderer;
  /** Test hooks. */
  repoFetch?: Partial<FetchRepoOptions>;
  net?: ReturnType<typeof nodeNet>;
}

const HOSTED_CAPS = { maxPages: 60, maxDepth: 4, concurrency: 6, maxAssetBytes: 5_000_000, targets: 10 };
const LOCAL_CAPS = { maxPages: 2000, maxDepth: 12, concurrency: 16, maxAssetBytes: 25_000_000, targets: 50 };

export function clampConfig(c: Partial<CrawlConfig> | undefined, mode: Mode): Partial<CrawlConfig> {
  const caps = mode === "hosted" ? HOSTED_CAPS : LOCAL_CAPS;
  const out: Partial<CrawlConfig> = { ...c };
  if (out.maxPages !== undefined) out.maxPages = Math.max(1, Math.min(Number(out.maxPages) || 1, caps.maxPages));
  if (out.maxDepth !== undefined) out.maxDepth = Math.max(0, Math.min(Number(out.maxDepth) || 0, caps.maxDepth));
  if (out.concurrency !== undefined) out.concurrency = Math.max(1, Math.min(Number(out.concurrency) || 1, caps.concurrency));
  if (out.maxAssetBytes !== undefined) out.maxAssetBytes = Math.max(10_000, Math.min(Number(out.maxAssetBytes) || 1e6, caps.maxAssetBytes));
  if (out.delayMs !== undefined) out.delayMs = Math.max(mode === "hosted" ? 50 : 0, Math.min(Number(out.delayMs) || 0, 10_000));
  if (mode === "hosted") { out.render = false; out.allowedHosts = (out.allowedHosts ?? []).slice(0, 5); }
  if (mode === "hosted" && out.respectRobots === undefined) out.respectRobots = true;
  return out;
}

/* ------------------------------------------------------------------ */

export async function analyzeHandler(req: Request, o: HandlerOptions): Promise<Response> {
  if (req.method !== "POST") return err("Use POST", 405);
  let body: { targets?: string[]; config?: Partial<CrawlConfig>; name?: string };
  try { body = await readJson(req, 200_000); } catch (e) { return err((e as Error).message, (e as HttpError).status ?? 400); }
  const caps = o.mode === "hosted" ? HOSTED_CAPS : LOCAL_CAPS;
  const targets = (body.targets ?? []).map((t) => String(t).trim()).filter(Boolean);
  if (!targets.length) return err("Provide at least one URL in `targets`.");
  if (targets.length > caps.targets) return err(`At most ${caps.targets} targets per analysis.`);
  const net = o.net ?? nodeNet({ allowPrivate: o.mode === "local" });
  for (const t of targets) {
    try { validateUrl(t, { allowPrivate: o.mode === "local" }); } catch (e) { return err(`${t}: ${(e as Error).message}`, e instanceof BlockedUrlError ? 400 : 422, { code: (e as BlockedUrlError).code }); }
  }
  const config = clampConfig(body.config, o.mode);
  const budget = o.maxDurationMs ?? (o.mode === "hosted" ? 270_000 : 6 * 3600_000);

  return sse(async (send, signal) => {
    const ctrl = new AbortController();
    signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, budget);
    let sentPages = 0;
    let sentLog = 0;
    try {
      const inv = await investigate({
        targets, name: body.name, config, fetch: net.fetch as never, dispatcher: net.dispatcher, resolver: net.resolver, allowPrivate: net.allowPrivate, signal: ctrl.signal,
        renderer: o.mode === "local" ? o.renderer : undefined,
        onUpdate: (i: Investigation) => {
          const pages = i.pages.slice(sentPages).map((p) => ({ id: p.id, url: p.url, status: p.status, title: p.title, depth: p.depth, via: p.discoveredVia, from: p.discoveredFrom }));
          sentPages = i.pages.length;
          const log = i.log.slice(sentLog);
          sentLog = i.log.length;
          send("update", { id: i.id, status: i.status, progress: i.progress, counts: { pages: i.pages.length, assets: i.assets.length, evidence: i.evidence.length }, pages, log });
        },
      });
      if (timedOut) {
        inv.status = "done";
        inv.limitations.unshift(`Time budget of ${Math.round(budget / 1000)} s reached: results are partial. Use the desktop app for deep crawls.`);
        inv.coverage = { ...inv.coverage, checks: [...inv.coverage.checks, { id: "budget", label: "Hosted time budget", status: "partial", detail: "Analysis stopped at the hosted time limit" }] };
      }
      send("done", inv);
    } finally {
      clearTimeout(timer);
    }
  }, req);
}

/* ------------------------------------------------------------------ */

function repoFetchOpts(o: HandlerOptions, token?: string, signal?: AbortSignal): FetchRepoOptions {
  const net = o.net ?? nodeNet({ allowPrivate: false });
  return { token, fetch: net.fetch as never, resolver: net.resolver, signal, ...o.repoFetch };
}

/** Fetch + analyse repos and report licences/assessment. Never returns a token. */
export async function repoInspectHandler(req: Request, o: HandlerOptions): Promise<Response> {
  if (req.method !== "POST") return err("Use POST", 405);
  let body: { urls?: string[]; token?: string; purpose?: "clone" | "port" | "mesh" };
  try { body = await readJson(req, 100_000); } catch (e) { return err((e as Error).message, (e as HttpError).status ?? 400); }
  const urls = (body.urls ?? []).map(String).filter(Boolean).slice(0, 8);
  if (!urls.length) return err("Provide at least one repository URL.");
  const results = await Promise.all(urls.map(async (u) => {
    try {
      const ref = parseRepoRef(u);
      const snap = await analyzeSnapshot(await fetchRepoSnapshot(ref, { ...repoFetchOpts(o, body.token, req.signal), maxBytes: 120_000_000 }));
      const a = snap.analysis!;
      return {
        ok: true as const, url: u, ref, sha: snap.sha, defaultBranch: snap.defaultBranch, description: snap.description, stars: snap.stars, isPrivate: snap.isPrivate,
        licenses: snap.licenses, effective: effective(snap.licenses), files: snap.files.length, bytes: snap.files.reduce((n, f) => n + f.data.byteLength, 0), skipped: snap.skipped.length,
        languages: a.languages.slice(0, 8), frameworks: a.frameworks, buildSystems: a.buildSystems, entrypoints: a.entrypoints.slice(0, 12), routes: a.routes.length, components: a.components.length,
        dependencies: a.dependencies.length, envVars: a.envVars.map((e) => e.name), database: a.databaseDefinitions, tree: snap.files.map((f) => f.path).slice(0, 3000),
      };
    } catch (e) {
      return { ok: false as const, url: u, error: e instanceof RepoRefError ? e.message : (e as Error).message };
    }
  }));
  const good = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
  const assessment = good.length ? assessRip(good.map((r) => ({ repo: `${r.ref.owner}/${r.ref.repo}`, licenses: r.licenses })), body.purpose ?? "clone") : null;
  return json({ repos: results, assessment });
}

/** Stream one repo's files as NDJSON: a header line then {path, b64} lines (no response-size ceiling). */
export async function repoFilesHandler(req: Request, o: HandlerOptions): Promise<Response> {
  if (req.method !== "POST") return err("Use POST", 405);
  let body: { url?: string; token?: string };
  try { body = await readJson(req, 20_000); } catch (e) { return err((e as Error).message, (e as HttpError).status ?? 400); }
  let snap;
  try {
    snap = await fetchRepoSnapshot(parseRepoRef(String(body.url ?? "")), { ...repoFetchOpts(o, body.token, req.signal), maxBytes: 120_000_000 });
  } catch (e) { return err((e as Error).message, e instanceof RepoRefError ? 400 : 502); }
  const enc = new TextEncoder();
  const lines = (function* () {
    yield JSON.stringify({ header: { ref: snap!.ref, sha: snap!.sha, defaultBranch: snap!.defaultBranch, description: snap!.description, stars: snap!.stars, licenses: snap!.licenses, skipped: snap!.skipped, fetchedAt: snap!.fetchedAt, method: snap!.method, count: snap!.files.length } }) + "\n";
    for (const f of snap!.files) yield JSON.stringify({ path: f.path, b64: bytesToB64(f.data) }) + "\n";
  })();
  const stream = new ReadableStream<Uint8Array>({ pull(c) { const n = lines.next(); if (n.done) c.close(); else c.enqueue(enc.encode(n.value)); } });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}

/* ------------------------------------------------------------------ */

/** Hosts the hosted forwarder may reach (APIs that do not allow browser CORS). */
export const FORWARD_ALLOW = new Set([
  "api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com", "api.x.ai", "api.moonshot.ai", "api.moonshot.cn", "openrouter.ai",
  "api.vercel.com", "api.github.com", "api.mistral.ai", "api.groq.com", "api.together.xyz", "api.deepseek.com",
]);
const FORWARD_HEADERS = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access", "content-type", "accept", "x-goog-api-key", "openai-organization", "http-referer", "x-title", "x-github-api-version"];

export async function forwardHandler(req: Request, o: HandlerOptions & { extraHosts?: string[] }): Promise<Response> {
  if (req.method !== "POST") return err("Use POST", 405);
  let body: { url?: string; method?: string; headers?: Record<string, string>; body?: string | null };
  try { body = await readJson(req, 30_000_000); } catch (e) { return err((e as Error).message, (e as HttpError).status ?? 400); }
  let url: URL;
  try { url = validateUrl(String(body.url ?? "")); } catch (e) { return err((e as Error).message, 400); }
  const allowed = FORWARD_ALLOW.has(url.hostname) || (o.extraHosts ?? []).includes(url.hostname);
  if (!allowed) return err(`The hosted forwarder only reaches known API hosts (${url.hostname} is not one). Call custom endpoints directly from the browser, or use the desktop app.`, 403);
  if (url.protocol !== "https:") return err("Only https is forwarded", 400);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.headers ?? {})) if (FORWARD_HEADERS.includes(k.toLowerCase())) headers[k.toLowerCase()] = String(v);
  const method = (body.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return err("Unsupported method");
  const net = o.net ?? nodeNet({ allowPrivate: false });
  let upstream: Response;
  try {
    upstream = (await net.fetch(url.toString(), { method, headers, body: method === "GET" ? undefined : (body.body ?? undefined), redirect: "manual", signal: req.signal })) as Response;
  } catch (e) { return err(`Upstream request failed: ${(e as Error).message}`, 502); }
  if (upstream.status >= 300 && upstream.status < 400) return err("Upstream tried to redirect; redirects are not followed", 502);
  const out = new Headers();
  for (const h of ["content-type", "retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"]) if (upstream.headers.get(h)) out.set(h, upstream.headers.get(h)!);
  out.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/* ------------------------------------------------------------------ */

/**
 * Verify that a URL really answers (used before the UI ever says "deployed").
 * Done server-side because browsers can't read cross-origin status codes; guarded like every other fetch.
 */
export async function probeHandler(req: Request, o: HandlerOptions): Promise<Response> {
  if (req.method !== "POST") return err("Use POST", 405);
  let body: { url?: string };
  try { body = await readJson(req, 4_000); } catch (e) { return err((e as Error).message, (e as HttpError).status ?? 400); }
  let url: URL;
  try { url = validateUrl(String(body.url ?? ""), { allowPrivate: o.mode === "local" }); } catch (e) { return err((e as Error).message, 400, { code: (e as BlockedUrlError).code }); }
  const net = o.net ?? nodeNet({ allowPrivate: o.mode === "local" });
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 15_000);
  req.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  const t0 = Date.now();
  try {
    const res = (await net.fetch(url.toString(), { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": "OmniForgeRE-verify/1.0", accept: "text/html,*/*" } })) as Response;
    let text = "";
    try { const r = res.body?.getReader(); let n = 0; const dec = new TextDecoder(); while (r && n < 65_536) { const { value, done } = await r.read(); if (done) break; n += value.length; text += dec.decode(value, { stream: true }); } await r?.cancel(); } catch { /* body optional */ }
    const title = text.match(/<title[^>]*>([^<]{0,200})<\/title>/i)?.[1]?.trim();
    const vercel = !!res.headers.get("x-vercel-id");
    // Vercel "Deployment Protection" answers 401 with an SSO page: the deployment exists but is not public.
    const protectedPage = vercel && (res.status === 401 || res.status === 403) && /authentication required|vercel authentication|sso/i.test(text + (res.headers.get("set-cookie") ?? ""));
    return json({ ok: res.ok, status: res.status, ms: Date.now() - t0, finalUrl: res.url, title, vercel, protected: protectedPage, contentType: res.headers.get("content-type") ?? undefined });
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code; return json({ ok: false, status: 0, ms: Date.now() - t0, error: (e as Error).name === "AbortError" ? "Timed out after 15 s" : `${(e as Error).message}${code ? ` (${code})` : ""}` });
  } finally { clearTimeout(timer); }
}
