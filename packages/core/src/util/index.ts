import { customAlphabet } from "nanoid";

const nano = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

/** Short, URL-safe, prefixed identifiers: `ev_x1y2z3...`. */
export const uid = (prefix: string) => `${prefix}_${nano()}`;

export const now = () => new Date().toISOString();

const enc = new TextEncoder();

export function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === "string") return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

/** SHA-256 hex digest using WebCrypto (Node ≥ 20 and every modern browser). */
export async function sha256(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = toBytes(data);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function truncate(s: string, max: number) {
  return s.length <= max ? s : s.slice(0, max) + `… [+${s.length - max} chars]`;
}

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Simple promise pool with a fixed concurrency. */
export async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export { redactSecrets, findSecretLikeValues, envVarNames, dotenvNames } from "./redact.js";
