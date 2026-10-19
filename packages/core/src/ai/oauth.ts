/**
 * "Sign in with OpenRouter": OpenRouter's OAuth PKCE flow creates an API key that belongs to the user, without the user copying keys.
 * Flow (OpenRouter docs, "OAuth PKCE"): send the user to https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256,
 * receive ?code=… on the callback, then POST { code, code_verifier, code_challenge_method } to https://openrouter.ai/api/v1/auth/keys → { key }.
 * Callback URLs may be https or localhost/127.0.0.1 on any port (used by the desktop engine).
 */
import { ProviderError } from "./types.js";

const b64url = (b: Uint8Array) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };

/** RFC 7636 verifier (43–128 chars, unreserved) and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

export function openRouterAuthUrl(callbackUrl: string, challenge: string, base = "https://openrouter.ai"): string {
  const cb = new URL(callbackUrl);
  const loop = /^(?:localhost|127\.0\.0\.1)$/.test(cb.hostname);
  if (cb.protocol !== "https:" && !(cb.protocol === "http:" && loop)) throw new Error("OpenRouter only accepts https callbacks (or localhost)");
  const u = new URL("/auth", base); u.searchParams.set("callback_url", callbackUrl); u.searchParams.set("code_challenge", challenge); u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function exchangeOpenRouterCode(code: string, verifier: string, o: { fetch?: typeof fetch; base?: string } = {}): Promise<string> {
  if (!/^[A-Za-z0-9._~-]{4,512}$/.test(code)) throw new ProviderError("OpenRouter returned an invalid authorization code", 400, "openrouter");
  const res = await (o.fetch ?? fetch)(`${o.base ?? "https://openrouter.ai"}/api/v1/auth/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }) });
  const text = await res.text(); let j: any = {}; try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new ProviderError(`OpenRouter sign-in failed (HTTP ${res.status})${j?.error?.message ? `: ${j.error.message}` : ""}`, res.status, "openrouter");
  if (typeof j.key !== "string" || !j.key) throw new ProviderError("OpenRouter did not return a key", res.status, "openrouter");
  return j.key;
}
