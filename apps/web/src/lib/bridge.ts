/** Client for the OmniForge desktop bridge (pairing, scoped calls, SSE). */
import { forwardBody } from "./forward-body";

export interface BridgeConn { url: string; token: string; kind: "ui" | "session"; scopes?: string[]; expiresAt?: number; version?: string }

export class BridgeError extends Error { constructor(public status: number, message: string) { super(message); this.name = "BridgeError"; } }

export async function probe(url: string, timeoutMs = 1500): Promise<{ ok: boolean; version?: string } | null> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(`${url.replace(/\/$/, "")}/bridge/health`, { signal: ctrl.signal }); if (!r.ok) return null; const j = await r.json(); return j?.name === "omniforge-bridge" ? { ok: true, version: j.version } : null; } catch { return null; } finally { clearTimeout(t); }
}

export async function pair(url: string, code: string): Promise<BridgeConn> {
  const base = url.replace(/\/$/, "");
  const r = await fetch(`${base}/bridge/pair`, { method: "POST", headers: { "content-type": "application/json", "x-omniforge-bridge": "1" }, body: JSON.stringify({ code: code.trim().toUpperCase() }) }).catch(() => { throw new BridgeError(0, "Could not reach the desktop companion. Is OmniForge running on this computer?"); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new BridgeError(r.status, j.error ?? "Pairing failed");
  return { url: base, token: j.token, kind: "session", scopes: j.scopes, expiresAt: j.expiresAt, version: j.version };
}

/** Desktop (Tauri) hands the webview its own bridge URL + app token. */
export async function tauriBridge(): Promise<BridgeConn | null> {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<any> } };
  if (!w.__TAURI_INTERNALS__) return null;
  const i = await w.__TAURI_INTERNALS__.invoke("bridge_info"); // rejects with the shell's own explanation if the engine failed to start
  if (!i?.url) throw new Error("The desktop shell returned no engine address.");
  return { url: i.url, token: i.uiToken, kind: "ui", version: i.version };
}
/** Writes one line to the app's engine.log (Help → Open Log Folder). Never pass secrets. */
export function desktopLog(message: string) {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<any> } };
  void w.__TAURI_INTERNALS__?.invoke("log_event", { message: message.slice(0, 500) }).catch(() => {});
}
export const isTauri = () => typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

export class Bridge {
  constructor(public conn: BridgeConn) {}
  private headers(extra: Record<string, string> = {}, body?: boolean) { return { authorization: `Bearer ${this.conn.token}`, "x-omniforge-bridge": "1", ...(body ? { "content-type": "application/json" } : {}), ...extra }; }
  async raw(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    let r: Response;
    try { r = await fetch(`${this.conn.url}${path}`, { method, headers: this.headers({}, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body), signal }); }
    catch (e) { if ((e as Error).name === "AbortError") throw e; throw new BridgeError(0, `Lost connection to the desktop companion (${(e as Error).name}: ${(e as Error).message}).`); }
    if (!r.ok) { const j = await r.clone().json().catch(() => ({})); throw new BridgeError(r.status, j.error ?? `Bridge error ${r.status}`); }
    return r;
  }
  async json<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> { return (await this.raw(method, path, body, signal)).json(); }
  get<T = any>(path: string) { return this.json<T>("GET", path); }
  post<T = any>(path: string, body?: unknown, signal?: AbortSignal) { return this.json<T>("POST", path, body ?? {}, signal); }
  fetchLike: typeof fetch = async (input, init) => {
    // used by smartFetch to forward model-server traffic
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {}; new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    return this.raw("POST", "/bridge/forward", { url, method: init?.method ?? "GET", headers, ...forwardBody(init?.body) }, init?.signal ?? undefined).catch((e: BridgeError) => new Response(JSON.stringify({ error: e.message }), { status: e.status || 502, headers: { "content-type": "application/json" } }));
  };
}

/** Read a Server-Sent-Events response, calling onEvent for each complete event. */
export async function readSSE(res: Response, onEvent: (event: string, data: any) => void, signal?: AbortSignal) {
  if (!res.body) return;
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = block.match(/^event: (.+)$/m)?.[1]; const data = block.match(/^data: ([\s\S]+)$/m)?.[1];
        if (ev && data) { try { onEvent(ev, JSON.parse(data)); } catch { /* skip malformed */ } }
      }
    }
  } finally { reader.cancel().catch(() => {}); }
}

export async function readNDJSON(res: Response, onLine: (o: any) => void) {
  if (!res.body) return; const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i: number; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(JSON.parse(l)); } }
  if (buf.trim()) onLine(JSON.parse(buf));
}
