/** "Sign in with OpenRouter" (OAuth PKCE): creates a key owned by the user and saves it like any other provider key (vault / Keychain). */
import { configFromPreset, exchangeOpenRouterCode, openRouterAuthUrl, pkcePair } from "@omniforge/core";
import { useApp } from "./store";
import { vault } from "./vault";
import { keyName } from "./ai";
import { smartFetch } from "./net";
import { audit } from "./audit";

const VERIFIER = "omniforge.openrouter.verifier";

async function saveKey(key: string) {
  const { providers, setProviders } = useApp.getState();
  const existing = providers.find((p) => p.preset === "openrouter");
  const cfg = existing ?? configFromPreset("openrouter");
  await vault.set(keyName(cfg.id), key);
  if (!existing) setProviders([...providers, cfg]); else setProviders([...providers]); // re-set to trigger model discovery
  void audit("provider signed in", "OpenRouter (OAuth)");
  return cfg;
}

/** Desktop: the engine opens the browser and receives the callback on loopback. Web: a normal redirect to OpenRouter and back. */
export async function signInWithOpenRouter(o: { signal?: AbortSignal; pollMs?: number } = {}): Promise<"done" | "redirecting"> {
  const b = useApp.getState().bridge;
  if (b && useApp.getState().bridgeState === "connected") {
    const { state } = await b.post<{ state: string }>("/bridge/oauth/openrouter/start", {});
    const until = Date.now() + 10 * 60_000;
    while (Date.now() < until) {
      if (o.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const r = await b.get<{ status: string; key?: string; error?: string }>(`/bridge/oauth/openrouter/result/${state}`);
      if (r.status === "done" && r.key) { await saveKey(r.key); return "done"; }
      if (r.status === "error" || r.status === "unknown") throw new Error(r.error ?? "The sign-in expired. Try again.");
      await new Promise((res) => setTimeout(res, o.pollMs ?? 1500));
    }
    throw new Error("Timed out waiting for OpenRouter sign-in.");
  }
  const { verifier, challenge } = await pkcePair();
  try { sessionStorage.setItem(VERIFIER, verifier); } catch { throw new Error("This browser blocks session storage, which sign-in needs. Paste an API key instead."); }
  window.location.assign(openRouterAuthUrl(`${window.location.origin}${window.location.pathname}`, challenge));
  return "redirecting";
}

/** Called once at start-up: finishes a web sign-in when OpenRouter redirected back with ?code=. */
export async function completeOpenRouterSignIn(): Promise<boolean> {
  const url = new URL(window.location.href); const code = url.searchParams.get("code");
  let verifier: string | null = null; try { verifier = sessionStorage.getItem(VERIFIER); } catch { /* none */ }
  if (!code || !verifier) return false;
  try { sessionStorage.removeItem(VERIFIER); } catch { /* ignore */ }
  url.searchParams.delete("code"); window.history.replaceState(null, "", url.toString()); // the code is single-use; don't leave it in the address bar
  const key = await exchangeOpenRouterCode(code, verifier, { fetch: smartFetch(() => useApp.getState().bridge) });
  await saveKey(key); return true;
}
