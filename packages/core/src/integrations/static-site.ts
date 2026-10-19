/**
 * Shared helpers for the static-site deploy targets (Netlify, Cloudflare Pages): file normalisation, base64,
 * and a poll loop with an injectable clock so timeouts are testable.
 */
import { ProviderError } from "../ai/types.js";

export interface SiteFile { path: string; data: Uint8Array | string }
export interface PollOptions { sleep?: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number; now?: () => number }

export const toBytes = (d: Uint8Array | string) => (typeof d === "string" ? new TextEncoder().encode(d) : d);

export function b64(d: Uint8Array | string): string {
  const bytes = toBytes(d);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** "./a\\b.css" → "a/b.css". Refuses absolute-escape and ".." segments instead of silently rewriting them. */
export function normalizeSitePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
  if (!parts.length) throw new Error(`Invalid file path “${p}”`);
  if (parts.includes("..")) throw new Error(`File path “${p}” leaves the site directory`);
  return parts.join("/");
}

/** Normalise every path and refuse duplicates (two inputs mapping to the same published path). */
export function normalizeSiteFiles(files: SiteFile[]): { path: string; bytes: Uint8Array }[] {
  const seen = new Set<string>(); const out: { path: string; bytes: Uint8Array }[] = [];
  for (const f of files) {
    const path = normalizeSitePath(f.path);
    if (seen.has(path)) throw new Error(`Duplicate file path “${path}”`);
    seen.add(path); out.push({ path, bytes: toBytes(f.data) });
  }
  if (!out.length) throw new Error("There are no files to deploy");
  return out;
}

export async function pollUntil<T>(o: PollOptions, provider: string, step: () => Promise<T | undefined>): Promise<T> {
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const deadline = now() + (o.timeoutMs ?? 10 * 60_000);
  while (now() < deadline) {
    const r = await step();
    if (r !== undefined) return r;
    await sleep(o.pollMs ?? 2000);
  }
  throw new ProviderError("Timed out waiting for the deployment to finish", undefined, provider);
}

export async function readJson(res: Response): Promise<{ json: any; text: string }> {
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  return { json, text };
}
