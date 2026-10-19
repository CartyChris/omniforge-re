/**
 * Cloudflare Pages "Direct Upload" (user-supplied API token + account id) — the same wire protocol `wrangler pages deploy`
 * uses for a static directory:
 *   1. GET  /accounts/{a}/pages/projects/{name}            (create with POST /accounts/{a}/pages/projects when 404 / code 8000007)
 *   2. GET  /accounts/{a}/pages/projects/{name}/upload-token → { jwt }
 *   3. POST /pages/assets/check-missing   { hashes }                          (Authorization: Bearer <jwt>)
 *   4. POST /pages/assets/upload          [{ key: hash, value: base64, metadata: { contentType }, base64: true }]
 *   5. POST /pages/assets/upsert-hashes   { hashes }                          (a failure here only slows the next deploy)
 *   6. POST /accounts/{a}/pages/projects/{name}/deployments  multipart/form-data: manifest = {"/path": hash}, [branch], [_headers], [_redirects]
 *   7. GET  /accounts/{a}/pages/projects/{name}/deployments/{id} until latest_stage deploy/success or a failure
 *
 * Read from the real source: wrangler 4.151.1 (npm `wrangler`), bundled file `wrangler-dist/cli.js` —
 *   hashFile in "../deploy-helpers/src/deploy/helpers/hash.ts":
 *     blake3Wasm.hash(contents.toString("base64") + path.extname(filepath).substring(1)).toString("hex").slice(0, 32)
 *   upload / validate in "src/pages/upload.ts" and "src/pages/validate.ts" (endpoints, payload shape, ignore list,
 *   25 MiB per-file limit, content type from the `mime` package), deploy in "src/api/pages/deploy.ts" (form fields),
 *   project create/exists in "src/pages/projects.ts"; responses are the v4 envelope { success, errors, result }.
 * The test vectors in test/deploy-targets.test.ts were produced with blake3-wasm 2.1.5 (wrangler's own dependency).
 *
 * Not supported (refused with a clear error, never silently dropped): `_worker.js` and a `functions/` directory —
 * those need wrangler's Functions bundler.
 *
 * Status: implemented and tested against a mock of the API as wrangler calls it; not verified against the live service.
 */
import { blake3 } from "@noble/hashes/blake3.js";
import { ProviderError } from "../ai/types.js";
import { b64, normalizeSiteFiles, pollUntil, readJson, type PollOptions, type SiteFile } from "./static-site.js";

export interface CfOptions extends PollOptions { token: string; accountId: string; fetch?: typeof fetch; api?: string; /** Max raw bytes per upload request (keeps each request under proxy body limits). */ bucketBytes?: number }
export interface CfAsset { path: string; hash: string; contentType: string; size: number; bytes: Uint8Array }
export interface CfDeployment { id: string; url?: string; alias?: string; stage?: string; status?: string; environment?: string; errorMessage?: string }

export class CloudflareError extends ProviderError {
  constructor(message: string, status: number | undefined, public readonly code?: number) { super(message, status, "cloudflare"); }
}

const MAX_ASSET_SIZE = 25 * 1024 * 1024; // wrangler MAX_ASSET_SIZE
const MAX_ASSET_COUNT = 20_000; // wrangler MAX_ASSET_COUNT_DEFAULT
const MAX_BUCKET_FILES = 2000; // wrangler MAX_BUCKET_FILE_COUNT (non-Windows)

/* ---------------- hashing (wrangler's scheme, exactly) ---------------- */

/** POSIX path.extname(p).substring(1): "" for dotfiles (".htaccess"), for "file." and for no extension. */
export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1);
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** blake3(base64(contents) + extension) → first 32 hex chars. */
export function hashAsset(path: string, data: Uint8Array | string): string {
  return hex(blake3(new TextEncoder().encode(b64(data) + extOf(path)))).slice(0, 32);
}

/* Content types: the subset of the `mime` package's standard/other tables that static sites use (wrangler: mime.getType(name) || "application/octet-stream"). */
const MIME: Record<string, string> = {
  html: "text/html", htm: "text/html", shtml: "text/html", css: "text/css", js: "application/javascript", mjs: "application/javascript", cjs: "application/node",
  json: "application/json", map: "application/json", webmanifest: "application/manifest+json", jsonld: "application/ld+json", xml: "application/xml", txt: "text/plain",
  md: "text/markdown", csv: "text/csv", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", ico: "image/vnd.microsoft.icon", bmp: "image/bmp", wasm: "application/wasm", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", pdf: "application/pdf", zip: "application/zip",
};
export const contentTypeOf = (path: string) => MIME[extOf(path).toLowerCase()] ?? "application/octet-stream";

/* ---------------- files → assets ---------------- */

/** Same exclusions as wrangler's validate(): these are never uploaded as assets. */
const IGNORED = (p: string) => /(^|\/)(\.DS_Store|node_modules|\.git)(\/|$)/.test(p) || /^\.wrangler(\/|$)/.test(p);
const SPECIAL = new Set(["_headers", "_redirects", "_routes.json", "_worker.js"]);

export function prepareAssets(files: SiteFile[]): { assets: CfAsset[]; headers?: string; redirects?: string } {
  const all = normalizeSiteFiles(files);
  const unsupported = all.filter((f) => f.path === "_worker.js" || f.path.startsWith("_worker.js/") || f.path.startsWith("functions/")).map((f) => f.path);
  if (unsupported.length) throw new Error(`Cloudflare Pages Functions (${unsupported.slice(0, 3).join(", ")}) need wrangler's bundler and are not supported here — deploy a static site, or use \`wrangler pages deploy\`.`);
  const dec = new TextDecoder();
  let headers: string | undefined, redirects: string | undefined; const assets: CfAsset[] = [];
  for (const f of all) {
    if (f.path === "_headers") { headers = dec.decode(f.bytes); continue; }
    if (f.path === "_redirects") { redirects = dec.decode(f.bytes); continue; }
    if (SPECIAL.has(f.path) || IGNORED(f.path)) continue;
    if (f.bytes.length > MAX_ASSET_SIZE) throw new Error(`Pages only supports files up to 25 MiB — ${f.path} is ${(f.bytes.length / 1048576).toFixed(1)} MiB`);
    assets.push({ path: f.path, hash: hashAsset(f.path, f.bytes), contentType: contentTypeOf(f.path), size: f.bytes.length, bytes: f.bytes });
  }
  if (!assets.length) throw new Error("There are no static files to upload");
  if (assets.length > MAX_ASSET_COUNT) throw new Error(`Pages supports up to ${MAX_ASSET_COUNT.toLocaleString()} files per deployment (got ${assets.length})`);
  return { assets, headers, redirects };
}

export const manifestOf = (assets: CfAsset[]) => Object.fromEntries(assets.map((a) => [`/${a.path}`, a.hash]));

/* ---------------- HTTP ---------------- */

async function cf<T>(o: CfOptions, method: string, path: string, init: { json?: unknown; body?: string; contentType?: string; bearer?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${init.bearer ?? o.token}` };
  let body: string | undefined;
  if (init.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(init.json); }
  if (init.body !== undefined) { headers["content-type"] = init.contentType!; body = init.body; }
  const res = await (o.fetch ?? fetch)(`${o.api ?? "https://api.cloudflare.com/client/v4"}${path}`, { method, headers, body });
  const { json, text } = await readJson(res);
  if (!res.ok || json.success === false) {
    const e0 = Array.isArray(json.errors) ? json.errors[0] : undefined;
    const hint = res.status === 401 ? " (token invalid or expired)" : res.status === 403 ? " (the token needs Account → Cloudflare Pages → Edit for this account)" : "";
    throw new CloudflareError(`Cloudflare ${method} ${path.split("?")[0]} → ${res.status}: ${e0?.message ?? text.slice(0, 200)}${e0?.code ? ` [${e0.code}]` : ""}${hint}`, res.status, e0?.code);
  }
  return json.result as T;
}

const acct = (o: CfOptions) => `/accounts/${encodeURIComponent(o.accountId)}`;

/** Pages project names: lowercase letters, digits and dashes, ≤ 58 chars (they become <name>.pages.dev). */
export const projectName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 58) || "site";

/** Verifies the token AND the account id together (a token can be valid but not for this account). */
export async function listProjects(o: CfOptions) {
  const r = await cf<any[]>(o, "GET", `${acct(o)}/pages/projects?per_page=10&page=1`);
  return (Array.isArray(r) ? r : []).map((p) => ({ name: p.name as string, subdomain: p.subdomain as string | undefined }));
}

export async function getProject(o: CfOptions, name: string): Promise<{ name: string; subdomain?: string; production_branch?: string } | null> {
  try { return await cf<any>(o, "GET", `${acct(o)}/pages/projects/${encodeURIComponent(name)}`); }
  catch (e) { if (e instanceof CloudflareError && (e.code === 8000007 || (e.status === 404 && e.code === undefined))) return null; throw e; }
}

export async function ensureProject(o: CfOptions, name: string, productionBranch = "main") {
  const p = await getProject(o, name);
  if (p) return { ...p, created: false };
  const c = await cf<any>(o, "POST", `${acct(o)}/pages/projects`, { json: { name, production_branch: productionBranch } });
  return { ...c, created: true };
}

export async function uploadToken(o: CfOptions, name: string): Promise<string> {
  const r = await cf<{ jwt?: string }>(o, "GET", `${acct(o)}/pages/projects/${encodeURIComponent(name)}/upload-token`);
  if (!r?.jwt) throw new CloudflareError("Cloudflare returned no upload token", undefined);
  return r.jwt;
}

/** check-missing → upload only what is missing (in size-bounded buckets) → upsert-hashes. Returns the manifest. */
export async function uploadAssets(o: CfOptions, jwt: string, assets: CfAsset[], onProgress?: (done: number, total: number) => void) {
  const hashes = assets.map((a) => a.hash);
  const missing = new Set(await cf<string[]>(o, "POST", "/pages/assets/check-missing", { bearer: jwt, json: { hashes } }));
  const todo = assets.filter((a) => missing.has(a.hash)).sort((a, b) => b.size - a.size);
  const limit = o.bucketBytes ?? 2_500_000; // ≈3.3 MB of base64 per request: fits the hosted forwarder's 4.5 MB body limit
  const buckets: CfAsset[][] = []; let cur: CfAsset[] = []; let size = 0;
  for (const a of todo) {
    if (cur.length && (size + a.size > limit || cur.length >= MAX_BUCKET_FILES)) { buckets.push(cur); cur = []; size = 0; }
    cur.push(a); size += a.size;
  }
  if (cur.length) buckets.push(cur);
  let done = assets.length - todo.length; onProgress?.(done, assets.length);
  for (const bucket of buckets) {
    await cf(o, "POST", "/pages/assets/upload", { bearer: jwt, json: bucket.map((a) => ({ key: a.hash, value: b64(a.bytes), metadata: { contentType: a.contentType }, base64: true })) });
    done += bucket.length; onProgress?.(done, assets.length);
  }
  let upsertWarning: string | undefined;
  try { await cf(o, "POST", "/pages/assets/upsert-hashes", { bearer: jwt, json: { hashes } }); }
  catch (e) { upsertWarning = `Uploaded, but updating the asset cache failed (the next deploy re-uploads): ${(e as Error).message}`; }
  return { manifest: manifestOf(assets), uploaded: todo.length, skipped: assets.length - todo.length, upsertWarning };
}

/** multipart/form-data as a string (text fields + text "files"), so it also travels through the app's JSON forwarders. */
export function multipartBody(parts: { name: string; value: string; filename?: string }[], boundary: string): string {
  const esc = (s: string) => s.replace(/"/g, "%22").replace(/\r|\n/g, " ");
  let out = "";
  for (const p of parts) {
    if (p.value.includes(`--${boundary}`)) throw new Error("multipart boundary collision");
    out += `--${boundary}\r\nContent-Disposition: form-data; name="${esc(p.name)}"${p.filename !== undefined ? `; filename="${esc(p.filename)}"\r\nContent-Type: application/octet-stream` : ""}\r\n\r\n${p.value}\r\n`;
  }
  return `${out}--${boundary}--\r\n`;
}

const toDeployment = (r: any): CfDeployment => ({ id: r.id, url: r.url ?? undefined, alias: (Array.isArray(r.aliases) ? r.aliases.find((a: string) => /\.pages\.dev$/.test(a)) : undefined) ?? undefined, stage: r.latest_stage?.name, status: r.latest_stage?.status, environment: r.environment });

export async function createDeployment(o: CfOptions, name: string, manifest: Record<string, string>, x: { branch?: string; headers?: string; redirects?: string; boundary?: string } = {}): Promise<CfDeployment> {
  const boundary = x.boundary ?? `----omniforge${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const parts: { name: string; value: string; filename?: string }[] = [{ name: "manifest", value: JSON.stringify(manifest) }];
  if (x.branch) parts.push({ name: "branch", value: x.branch });
  if (x.headers !== undefined) parts.push({ name: "_headers", value: x.headers, filename: "_headers" });
  if (x.redirects !== undefined) parts.push({ name: "_redirects", value: x.redirects, filename: "_redirects" });
  const r = await cf<any>(o, "POST", `${acct(o)}/pages/projects/${encodeURIComponent(name)}/deployments`, { body: multipartBody(parts, boundary), contentType: `multipart/form-data; boundary=${boundary}` });
  if (!r?.id) throw new CloudflareError("Cloudflare accepted the deployment but returned no id", undefined);
  return toDeployment(r);
}

/** Poll until the "deploy" stage succeeds or any stage fails. A finished deployment without a URL is an error, not a guess. */
export async function waitForDeployment(o: CfOptions, name: string, id: string, onState?: (s: string) => void): Promise<CfDeployment> {
  let last = "";
  const base = `${acct(o)}/pages/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(id)}`;
  return pollUntil(o, "cloudflare", async () => {
    const d = toDeployment(await cf<any>(o, "GET", base));
    const s = `${d.stage ?? "queued"}: ${d.status ?? "pending"}`;
    if (s !== last) { last = s; onState?.(s); }
    if (d.status === "failure" || d.status === "canceled") {
      let msg: string | undefined;
      try { const logs = await cf<any>(o, "GET", `${base}/history/logs?size=200`); const lines = (logs?.data ?? []) as { line?: string }[]; msg = lines.at(-1)?.line?.replace(/^Error:/, "").trim(); } catch { /* best effort */ }
      return { ...d, errorMessage: msg || `Cloudflare reported the ${d.stage ?? "deployment"} stage ${d.status}` };
    }
    if (d.stage === "deploy" && d.status === "success") {
      if (!d.url && !d.alias) throw new CloudflareError("Cloudflare reported the deployment finished but returned no URL", undefined);
      return d;
    }
    return undefined;
  });
}

/** Whole flow: project → token → assets → deployment → wait. */
export async function deploySite(o: CfOptions, files: SiteFile[], t: { name: string; branch?: string }, onState?: (s: string) => void) {
  const { assets, headers, redirects } = prepareAssets(files); // validate before touching the account
  const name = projectName(t.name);
  const project = await ensureProject(o, name);
  onState?.(project.created ? "project created" : "project found");
  const jwt = await uploadToken(o, name);
  const up = await uploadAssets(o, jwt, assets, (d, n) => onState?.(`uploading ${d}/${n}`));
  const created = await createDeployment(o, name, up.manifest, { branch: t.branch, headers, redirects });
  const done = await waitForDeployment(o, name, created.id, onState);
  return { project: { name, created: project.created, subdomain: project.subdomain as string | undefined }, upload: up, deployment: { ...done, url: done.url ?? created.url } };
}
