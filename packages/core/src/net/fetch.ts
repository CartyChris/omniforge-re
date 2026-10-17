import { BlockedUrlError, validateUrlResolved, type Resolver, type UrlPolicy } from "./ssrf.js";

export type FetchLike = (input: string, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>;

export interface SafeFetchOptions extends UrlPolicy {
  fetch?: FetchLike;
  resolver?: Resolver;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  method?: string;
  signal?: AbortSignal;
  /** Extra per-hop check (e.g. crawl scope). Throw to block. */
  beforeHop?: (url: URL) => void;
  /** Passed straight to fetch (Node: undici dispatcher with connect-time IP filtering). */
  dispatcher?: unknown;
}

export interface SafeResponse {
  url: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Uint8Array;
  truncated: boolean;
  ms: number;
  redirects: string[];
  /** Cookie names + attributes set by the response. Values are never retained. */
  cookies: { name: string; secure: boolean; httpOnly: boolean; sameSite?: string }[];
  cookieNames: string[];
  text(): string;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

async function readCapped(res: Response, max: number, signal?: AbortSignal): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (!res.body) return { body: new Uint8Array(await res.arrayBuffer()).slice(0, max), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      if (total + value.byteLength > max) {
        chunks.push(value.slice(0, max - total));
        total = max;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.byteLength;
  }
  return { body, truncated };
}

/**
 * fetch() with SSRF validation on every hop, manual redirects, a byte cap
 * and a timeout. Works with any fetch implementation (Node, browser, Tauri).
 */
export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const doFetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const max = opts.maxBytes ?? 5_000_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const started = Date.now();
  const redirects: string[] = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let current = input;
  try {
    for (let hop = 0; ; hop++) {
      const url = await validateUrlResolved(current, opts);
      opts.beforeHop?.(url);
      const res = await doFetch(url.toString(), {
        method: opts.method ?? "GET",
        headers: { accept: "*/*", ...opts.headers },
        redirect: "manual",
        signal: ctrl.signal,
        ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop >= maxRedirects) throw new BlockedUrlError(`Too many redirects (>${maxRedirects})`, "invalid");
        const next = new URL(res.headers.get("location")!, url).toString();
        redirects.push(next);
        await res.body?.cancel().catch(() => {});
        current = next;
        continue;
      }
      const { body, truncated } = await readCapped(res, max, ctrl.signal);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      const rawCookies: string[] = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      const cookies = rawCookies
        .map((c) => {
          const [pair, ...attrs] = c.split(";").map((x) => x.trim());
          const low = attrs.map((a) => a.toLowerCase());
          return {
            name: (pair ?? "").split("=")[0]!.trim(),
            secure: low.includes("secure"),
            httpOnly: low.includes("httponly"),
            sameSite: low.find((a) => a.startsWith("samesite="))?.split("=")[1],
          };
        })
        .filter((c) => c.name);
      const cookieNames = cookies.map((c) => c.name);
      delete headers["set-cookie"]; // never keep cookie values
      return {
        url: url.toString(),
        status: res.status,
        ok: res.ok,
        headers,
        body,
        truncated,
        ms: Date.now() - started,
        redirects,
        cookies,
        cookieNames,
        text: () => decoder.decode(body),
      };
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
