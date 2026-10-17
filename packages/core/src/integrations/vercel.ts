/**
 * Vercel REST deployment (user-supplied token): create a deployment from inline
 * files, poll until READY/ERROR, and return the REAL URL — never a guess.
 */
import { ProviderError } from "../ai/types.js";

export interface VcOptions { token: string; teamId?: string; fetch?: typeof fetch; api?: string; sleep?: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number }
export interface VcFile { path: string; data: Uint8Array | string }

const b64 = (d: Uint8Array | string) => {
  const bytes = typeof d === "string" ? new TextEncoder().encode(d) : d;
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function vc<T>(o: VcOptions, method: string, path: string, body?: unknown): Promise<T> {
  const q = o.teamId ? `${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(o.teamId)}` : "";
  const res = await (o.fetch ?? fetch)(`${o.api ?? "https://api.vercel.com"}${path}${q}`, { method, headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
  if (!res.ok) throw new ProviderError(`Vercel ${method} ${path.split("?")[0]} → ${res.status}: ${json.error?.message ?? text.slice(0, 200)}${res.status === 403 ? " (check the token's scope/team)" : ""}`, res.status, "vercel");
  return json as T;
}

export async function listTeams(o: VcOptions) {
  const r = await vc<any>({ ...o, teamId: undefined }, "GET", "/v2/teams");
  return (r.teams ?? []).map((t: any) => ({ id: t.id as string, slug: t.slug as string, name: t.name as string }));
}

export interface DeployOptions { name: string; target?: "production" | "preview"; framework?: string | null; buildCommand?: string; installCommand?: string; outputDirectory?: string; env?: Record<string, string> }
export interface Deployment { id: string; url: string; state: string; inspectorUrl?: string; readyState: string; errorMessage?: string }

export async function createDeployment(o: VcOptions, files: VcFile[], d: DeployOptions): Promise<Deployment> {
  const r = await vc<any>(o, "POST", "/v13/deployments?skipAutoDetectionConfirmation=1", {
    name: d.name.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 52),
    target: d.target === "production" ? "production" : undefined,
    files: files.map((f) => ({ file: f.path, data: b64(f.data), encoding: "base64" })),
    projectSettings: { framework: d.framework ?? null, buildCommand: d.buildCommand ?? null, installCommand: d.installCommand ?? null, outputDirectory: d.outputDirectory ?? null },
    ...(d.env ? { env: d.env } : {}),
  });
  return { id: r.id, url: `https://${r.url}`, state: r.readyState, readyState: r.readyState, inspectorUrl: r.inspectorUrl };
}

export async function waitForDeployment(o: VcOptions, id: string, onState?: (s: string) => void): Promise<Deployment> {
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (o.timeoutMs ?? 10 * 60_000);
  let last = "";
  while (Date.now() < deadline) {
    const r = await vc<any>(o, "GET", `/v13/deployments/${id}`);
    if (r.readyState !== last) { last = r.readyState; onState?.(last); }
    if (r.readyState === "READY") return { id, url: `https://${r.url}`, state: "READY", readyState: "READY", inspectorUrl: r.inspectorUrl };
    if (r.readyState === "ERROR" || r.readyState === "CANCELED") return { id, url: `https://${r.url}`, state: r.readyState, readyState: r.readyState, inspectorUrl: r.inspectorUrl, errorMessage: r.errorMessage ?? "Build failed — see the build log" };
    await sleep(o.pollMs ?? 3000);
  }
  throw new ProviderError("Timed out waiting for the deployment to finish", undefined, "vercel");
}

export async function buildLog(o: VcOptions, id: string, max = 200): Promise<string[]> {
  const r = await vc<any>(o, "GET", `/v3/deployments/${id}/events?limit=${max}`);
  return (Array.isArray(r) ? r : []).map((e: any) => e.text ?? e.payload?.text ?? "").filter(Boolean);
}

/** Verify a URL really responds (used by the UI before it ever says "deployed"). */
export async function smokeTest(url: string, f: typeof fetch = fetch) {
  const t = Date.now();
  const res = await f(url, { redirect: "follow" });
  return { ok: res.ok, status: res.status, ms: Date.now() - t };
}
