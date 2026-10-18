/**
 * Audit trail of sensitive operations (approvals, credential changes, privacy-mode changes, exports/imports, deletions, analyses started).
 * Persisted locally (last 1000 entries), never contains secret values or analysed content, and is exportable from Settings → Diagnostics.
 */
import { db } from "./storage";
import { appLog } from "./log";

export interface AuditEntry { t: number; action: string; detail: string }
const KEY = "audit:log";
let cache: AuditEntry[] | null = null; const subs = new Set<() => void>();
const scrub = (s: string) => s.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})/g, "[redacted]").slice(0, 400);

let chain: Promise<unknown> = Promise.resolve();
async function load() { return (cache ??= (await db.get<AuditEntry[]>(KEY)) ?? []); }

/** Writes are serialised so entries recorded in the same tick (e.g. approval + start) are never lost. */
export function audit(action: string, detail = ""): Promise<void> {
  const run = async () => {
    const list = await load(); const e = { t: Date.now(), action, detail: scrub(detail) };
    cache = [...list.slice(-999), e]; await db.set(KEY, cache);
    appLog.push("info", "audit", `${action}${e.detail ? `: ${e.detail}` : ""}`); subs.forEach((f) => f());
  };
  const next = chain.then(run, run); chain = next.catch(() => undefined); return next;
}
export const readAudit = load;
export const clearAudit = async () => { cache = []; await db.set(KEY, []); subs.forEach((f) => f()); };
export const subscribeAudit = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
