/**
 * Loads the retire.js repository (Apache-2.0) for library-version detection.
 *
 * It is a public, static data file; fetching it sends nothing about the user or the target. It is fetched with the guarded network
 * stack, size- and time-limited, validated by core's `parseRepository` (which drops malformed, oversized and catastrophic-regex rules),
 * and cached in memory for a day. Any failure is reported to the caller, which records it as a limitation instead of pretending the step ran.
 */
import { parseRepository, type RetireRepository } from "@omniforge/core";

export const RETIRE_URL = "https://raw.githubusercontent.com/RetireJS/retire.js/master/repository/jsrepository-v4.json";
const MAX_BYTES = 6_000_000; const TTL_MS = 24 * 3600_000; const TIMEOUT_MS = 20_000;

export interface RetireLoad { repo?: RetireRepository; error?: string; stats?: { components: number; rules: number; dropped: number } }
let cache: { at: number; url: string; value: RetireLoad } | undefined; let inflight: Promise<RetireLoad> | undefined;

export function clearRetireCache() { cache = undefined; inflight = undefined; }

export async function loadRetireRepository(o: { fetch?: typeof fetch; url?: string; now?: () => number } = {}): Promise<RetireLoad> {
  const url = o.url ?? RETIRE_URL; const now = (o.now ?? Date.now)();
  if (cache && cache.url === url && now - cache.at < TTL_MS && cache.value.repo) return cache.value;
  if (inflight) return inflight;
  inflight = (async (): Promise<RetireLoad> => {
    try {
      const res = await (o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
      if (!res.ok) return { error: `the retire.js repository answered HTTP ${res.status}` };
      const len = Number(res.headers.get("content-length")); if (len > MAX_BYTES) return { error: "the retire.js repository is larger than the 6 MB limit" };
      const buf = new Uint8Array(await res.arrayBuffer()); if (buf.byteLength > MAX_BYTES) return { error: "the retire.js repository is larger than the 6 MB limit" };
      const p = parseRepository(JSON.parse(new TextDecoder().decode(buf)));
      const value: RetireLoad = { repo: p.repo, stats: { components: p.components, rules: p.rules, dropped: p.dropped } };
      cache = { at: now, url, value }; return value;
    } catch (e) { return { error: `the retire.js repository could not be loaded (${(e as Error).message})` }; }
    finally { inflight = undefined; }
  })();
  return inflight;
}
