/**
 * Network routing for AI provider calls.
 *   • local model servers (localhost) → via the paired bridge when available (works on HTTPS pages, Safari, any CORS config)
 *   • public APIs known to allow browser CORS → direct
 *   • other allow-listed APIs → bridge forwarder if paired, else the hosted /api/forward
 *   • anything else → direct (user's custom endpoint; CORS is the endpoint's responsibility)
 */
import { isTauri, type Bridge } from "./bridge";

const DIRECT_OK = new Set(["api.osv.dev", "api.anthropic.com", "api.openai.com", "openrouter.ai", "generativelanguage.googleapis.com", "api.mistral.ai", "api.groq.com", "api.together.xyz", "api.deepseek.com", "api.github.com"]);
const FORWARDABLE = new Set(["api.x.ai", "api.moonshot.ai", "api.moonshot.cn", "api.vercel.com", ...DIRECT_OK]);
const isLocal = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";

export function smartFetch(getBridge: () => Bridge | null, hostedBase = ""): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const bridge = getBridge();
    if (isLocal(url.hostname)) {
      if (bridge) return bridge.fetchLike(url.toString(), init);
      return fetch(url, init); // direct: works on localhost dev and in Chrome/Firefox; surfaced clearly when it fails
    }
    // Desktop app: every provider call goes through the local engine (no browser CORS rules, one place to enforce the host allow-list).
    if (DIRECT_OK.has(url.hostname)) return bridge && isTauri() ? bridge.fetchLike(url.toString(), init) : fetch(url, init);
    if (FORWARDABLE.has(url.hostname)) {
      if (bridge) return bridge.fetchLike(url.toString(), init);
      const headers: Record<string, string> = {}; new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      return fetch(`${hostedBase}/api/forward`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: url.toString(), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null }), signal: init?.signal });
    }
    return fetch(url, init);
  };
}
