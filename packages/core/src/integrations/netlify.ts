/**
 * Netlify deploy (user-supplied personal access token): find or create a site, upload a ZIP of the files
 * (POST /api/v1/sites/{id}/deploys, content-type application/zip), poll GET /api/v1/deploys/{id} until "ready" or
 * "error", and return the URL the API reported (ssl_url / deploy_ssl_url) — never one built from the site name.
 *
 * Status: implemented and tested against a mock of the documented API; not verified against the live service.
 */
import { zipSync } from "fflate";
import { ProviderError } from "../ai/types.js";
import { normalizeSiteFiles, pollUntil, readJson, type PollOptions, type SiteFile } from "./static-site.js";

export interface NlOptions extends PollOptions { token: string; fetch?: typeof fetch; api?: string }
export interface NlSite { id: string; name: string; url?: string }
export interface NlDeploy { id: string; siteId?: string; state: string; url?: string; deployUrl?: string; adminUrl?: string; errorMessage?: string }

async function nl<T>(o: NlOptions, method: string, path: string, body?: { json?: unknown; zip?: Uint8Array }): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${o.token}` };
  let payload: string | Uint8Array | undefined;
  if (body?.json !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body.json); }
  if (body?.zip) { headers["content-type"] = "application/zip"; payload = body.zip; }
  const res = await (o.fetch ?? fetch)(`${o.api ?? "https://api.netlify.com"}${path}`, { method, headers, body: payload as BodyInit | undefined });
  const { json, text } = await readJson(res);
  if (!res.ok) {
    const hint = res.status === 401 ? " (token invalid or expired)" : res.status === 403 ? " (the token cannot access this site/team)" : res.status === 422 ? " (rejected — e.g. a site name that is already taken)" : "";
    throw new ProviderError(`Netlify ${method} ${path.split("?")[0]} → ${res.status}: ${json.message ?? json.error ?? text.slice(0, 200)}${hint}`, res.status, "netlify");
  }
  return json as T;
}

/** Netlify site names: lowercase letters, digits and hyphens (they become <name>.netlify.app). */
export const siteName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "site";

export async function whoami(o: NlOptions) {
  const r = await nl<any>(o, "GET", "/api/v1/user");
  return { email: r.email as string | undefined, name: (r.full_name ?? r.slug) as string | undefined };
}

const toSite = (r: any): NlSite => ({ id: r.id ?? r.site_id, name: r.name, url: r.ssl_url ?? r.url });

/** Exact-name lookup among the sites this token can see (the API filters by substring, so we match exactly). */
export async function findSite(o: NlOptions, name: string): Promise<NlSite | null> {
  const r = await nl<any[]>(o, "GET", `/api/v1/sites?name=${encodeURIComponent(name)}&filter=all`);
  const hit = (Array.isArray(r) ? r : []).find((s) => s.name === name);
  return hit ? toSite(hit) : null;
}

export async function createSite(o: NlOptions, name: string): Promise<NlSite> {
  const r = await nl<any>(o, "POST", "/api/v1/sites", { json: { name } });
  if (!r.id) throw new ProviderError("Netlify created a site but returned no id", undefined, "netlify");
  return toSite(r);
}

/** Use an existing site (by id, or by exact name) or create one. */
export async function ensureSite(o: NlOptions, t: { siteId?: string; name: string }): Promise<NlSite & { created: boolean }> {
  if (t.siteId) { const r = await nl<any>(o, "GET", `/api/v1/sites/${encodeURIComponent(t.siteId)}`); return { ...toSite(r), created: false }; }
  const name = siteName(t.name);
  const found = await findSite(o, name);
  if (found) return { ...found, created: false };
  return { ...(await createSite(o, name)), created: true };
}

/** The ZIP Netlify receives: files at the archive root, paths normalised, ".." refused. */
export function zipSite(files: SiteFile[]): Uint8Array {
  return zipSync(Object.fromEntries(normalizeSiteFiles(files).map((f) => [f.path, f.bytes])), { level: 6 });
}

const toDeploy = (r: any): NlDeploy => ({ id: r.id, siteId: r.site_id, state: r.state, url: r.ssl_url ?? r.url ?? undefined, deployUrl: r.deploy_ssl_url ?? r.deploy_url ?? undefined, adminUrl: r.admin_url ?? undefined, errorMessage: r.error_message ?? undefined });

export async function uploadZip(o: NlOptions, siteId: string, files: SiteFile[]): Promise<NlDeploy> {
  const r = await nl<any>(o, "POST", `/api/v1/sites/${encodeURIComponent(siteId)}/deploys`, { zip: zipSite(files) });
  if (!r.id) throw new ProviderError("Netlify accepted the upload but returned no deploy id", undefined, "netlify");
  return toDeploy(r);
}

/** Polls until "ready" or "error". A ready deploy without a URL in the response is an error, not a guess. */
export async function waitForDeploy(o: NlOptions, id: string, onState?: (s: string) => void): Promise<NlDeploy> {
  let last = "";
  return pollUntil(o, "netlify", async () => {
    const d = toDeploy(await nl<any>(o, "GET", `/api/v1/deploys/${encodeURIComponent(id)}`));
    if (d.state !== last) { last = d.state; onState?.(last); }
    if (d.state === "error") return { ...d, errorMessage: d.errorMessage ?? "Netlify reported the deploy failed" };
    if (d.state === "ready") {
      if (!d.url && !d.deployUrl) throw new ProviderError("Netlify reported the deploy ready but returned no URL", undefined, "netlify");
      return d;
    }
    return undefined;
  });
}

/** Whole flow: site → upload → wait. */
export async function deploySite(o: NlOptions, files: SiteFile[], t: { siteId?: string; name: string }, onState?: (s: string) => void) {
  const site = await ensureSite(o, t);
  onState?.(site.created ? "site created" : "site found");
  const up = await uploadZip(o, site.id, files);
  onState?.(up.state ?? "uploaded");
  const done = await waitForDeploy(o, up.id, onState);
  return { site, deploy: done };
}
