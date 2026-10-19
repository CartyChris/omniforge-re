/**
 * Static-site deploy targets (Netlify, Cloudflare Pages). Credentials live only in the vault (Keychain on desktop);
 * every deploy is approved by the user first and recorded in the audit trail. Files are uploaded as-is — no build runs.
 */
import { cloudflare, netlify } from "@omniforge/core";
import { vault } from "./vault";
import { appFetch } from "./github";
import { requestApproval } from "./approvals";
import { audit } from "./audit";

export const NL_KEY = "token:netlify";
export const CF_KEY = "token:cloudflare";
export const CF_ACCOUNT_KEY = "cloudflare:account";

const get = async (k: string) => { try { return await vault.get(k); } catch { return undefined; } };
export const nlOpts = async () => { const token = await get(NL_KEY); if (!token) throw new Error("Connect Netlify first (Integrations → Netlify)."); return { token, fetch: appFetch() }; };
export const cfOpts = async () => {
  const [token, accountId] = await Promise.all([get(CF_KEY), get(CF_ACCOUNT_KEY)]);
  if (!token || !accountId) throw new Error("Connect Cloudflare first (Integrations → Cloudflare Pages).");
  return { token, accountId, fetch: appFetch() };
};

export type StaticTarget = "netlify" | "cloudflare";
export const TARGET_LABEL: Record<StaticTarget, string> = { netlify: "Netlify", cloudflare: "Cloudflare Pages" };

/** The files under `dir` ("" or "." = the whole workspace), re-rooted so `dir/index.html` is published as `index.html`. */
export function siteFiles(files: Record<string, string>, dir: string): { path: string; data: string }[] {
  const d = dir.replace(/^\.?\/*|\/+$/g, "");
  return Object.entries(files).filter(([p]) => !d || p.startsWith(`${d}/`)).map(([p, data]) => ({ path: d ? p.slice(d.length + 1) : p, data }));
}

/** The likely build output folder: dist/build/out/public when it holds an index.html, else the root when it does. */
export function guessPublishDir(files: Record<string, string>): string {
  for (const d of ["dist", "build", "out", "public", "_site"]) if (files[`${d}/index.html`] !== undefined) return d;
  return "";
}

export interface StaticResult { url?: string; deployUrl?: string; ok: boolean; state: string; error?: string }

/** Ask first, then deploy. Returns only URLs the vendor API reported. */
export async function deployStatic(target: StaticTarget, name: string, files: { path: string; data: string }[], o: { branch?: string; onState?: (s: string) => void } = {}): Promise<StaticResult> {
  const label = TARGET_LABEL[target];
  const where = target === "netlify" ? `your Netlify account (site “${netlify.siteName(name)}”, created if it does not exist; the deploy is published to that site)` : `your Cloudflare account (Pages project “${cloudflare.projectName(name)}”, created if it does not exist; ${o.branch ? `preview branch “${o.branch}”` : "production"})`;
  const creds = target === "netlify" ? await nlOpts() : await cfOpts(); // fail fast, before asking
  const ok = await requestApproval({ kind: "deploy", title: `Deploy “${name}” to ${label}?`, detail: `${files.length} files will be uploaded as-is (no build step) to ${where}.` });
  if (!ok) throw new Error("Deployment cancelled.");
  void audit(`${target} deploy started`, `${name} (${files.length} files)`);
  try {
    if (target === "netlify") {
      const r = await netlify.deploySite(creds, files, { name }, o.onState);
      const res: StaticResult = r.deploy.state === "ready" ? { ok: true, state: "ready", url: r.deploy.url ?? r.deploy.deployUrl, deployUrl: r.deploy.deployUrl } : { ok: false, state: r.deploy.state, error: r.deploy.errorMessage, deployUrl: r.deploy.deployUrl };
      void audit(`netlify deploy ${res.ok ? "ready" : "failed"}`, `${name}${res.url ? ` → ${res.url}` : ""}${res.error ? ` — ${res.error}` : ""}`);
      return res;
    }
    const r = await cloudflare.deploySite(creds as Awaited<ReturnType<typeof cfOpts>>, files, { name, branch: o.branch }, o.onState);
    const d = r.deployment;
    const res: StaticResult = d.status === "success" ? { ok: true, state: "success", url: d.url ?? d.alias, deployUrl: d.alias } : { ok: false, state: d.status ?? "unknown", error: d.errorMessage, deployUrl: d.url };
    void audit(`cloudflare deploy ${res.ok ? "ready" : "failed"}`, `${name}${res.url ? ` → ${res.url}` : ""}${res.error ? ` — ${res.error}` : ""}`);
    return res;
  } catch (e) { void audit(`${target} deploy failed`, `${name} — ${(e as Error).message}`); throw e; }
}
