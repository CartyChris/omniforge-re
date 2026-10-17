import { ProviderError, type ProviderConfig } from "../types.js";

export const redactKey = (s: string, key?: string) => {
  let out = s;
  if (key && key.length > 6) out = out.split(key).join("[REDACTED]");
  return out.replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1…[REDACTED]").replace(/(AIza[0-9A-Za-z_-]{4})[0-9A-Za-z_-]+/g, "$1…[REDACTED]");
};

export function joinUrl(base: string, path: string) {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

export async function http(cfg: ProviderConfig, path: string, init: RequestInit & { json?: unknown; signal?: AbortSignal; headers?: Record<string, string> }, fetchImpl: typeof fetch = globalThis.fetch): Promise<Response> {
  const url = joinUrl(cfg.baseUrl, path);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      headers: { "content-type": "application/json", ...cfg.headers, ...init.headers },
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const why = cause?.code ?? cause?.message ?? (e as Error).message;
    throw new ProviderError(`Cannot reach ${cfg.label} at ${cfg.baseUrl}: ${redactKey(String(why), cfg.apiKey)}${cfg.local ? ". Is the service running and is the port correct?" : ""}`, undefined, cfg.id, true);
  }
  if (!res.ok) {
    const body = redactKey((await res.text().catch(() => "")).slice(0, 600), cfg.apiKey);
    let msg = body;
    try {
      const j = JSON.parse(body);
      msg = j.error?.message ?? j.error ?? j.message ?? body;
      if (typeof msg !== "string") msg = JSON.stringify(msg);
    } catch { /* keep raw */ }
    throw new ProviderError(`${cfg.label} returned HTTP ${res.status}${msg ? `: ${msg}` : ""}`, res.status, cfg.id, res.status === 429 || res.status >= 500);
  }
  return res;
}
