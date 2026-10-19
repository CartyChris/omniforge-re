/**
 * gitleaks' default detection rules, applied as DATA (no gitleaks binary): keyword prefilter → regex → secret group →
 * Shannon-entropy floor → rule and global allowlists, as gitleaks documents them. Used by redaction so 200+ provider key
 * formats are caught, not just the handful in redact.ts.
 */
import { GITLEAKS } from "./gitleaks-rules";

type Pat = [string, string]; // [source, flags]
export interface GitleaksAllow { regexes?: Pat[]; target?: "secret" | "match" | "line"; stopwords?: string[]; paths?: Pat[]; condition?: "OR" | "AND" }
export interface GitleaksRule { id: string; re: string; flags?: string; keywords?: string[]; entropy?: number; group?: number; path?: Pat; allow?: GitleaksAllow[] }
export interface GitleaksData { version: string; rules: GitleaksRule[]; allow: { regexes: Pat[]; stopwords: string[]; paths: Pat[] } }

interface Compiled { id: string; re: RegExp; keywords: string[]; entropy?: number; group?: number; path?: RegExp; allow: { regexes: RegExp[]; target: string; stopwords: string[]; paths: RegExp[]; and: boolean }[] }

const rx = ([s, f]: Pat, g = false): RegExp | null => { try { return new RegExp(s, f + (g ? "g" : "")); } catch { return null; } };

let compiled: { rules: Compiled[]; skipped: string[]; allowRe: RegExp[]; stop: string[]; allowPaths: RegExp[] } | undefined;
export function gitleaksRules() {
  if (compiled) return compiled;
  const rules: Compiled[] = []; const skipped: string[] = [];
  for (const r of GITLEAKS.rules) {
    const re = rx([r.re, r.flags ?? ""], true);
    if (!re) { skipped.push(r.id); continue; }
    rules.push({ id: r.id, re, keywords: r.keywords ?? [], entropy: r.entropy, group: r.group, path: r.path ? rx(r.path) ?? undefined : undefined,
      allow: (r.allow ?? []).map((a) => ({ regexes: (a.regexes ?? []).map((p) => rx(p)).filter((x): x is RegExp => !!x), target: a.target ?? "secret", stopwords: (a.stopwords ?? []).map((s) => s.toLowerCase()), paths: (a.paths ?? []).map((p) => rx(p)).filter((x): x is RegExp => !!x), and: a.condition === "AND" })) });
  }
  compiled = { rules, skipped, allowRe: GITLEAKS.allow.regexes.map((p) => rx(p)).filter((x): x is RegExp => !!x), stop: GITLEAKS.allow.stopwords.map((s) => s.toLowerCase()), allowPaths: GITLEAKS.allow.paths.map((p) => rx(p)).filter((x): x is RegExp => !!x) };
  return compiled;
}

export function shannon(s: string): number {
  const n = new Map<string, number>(); for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0; for (const v of n.values()) { const p = v / s.length; h -= p * Math.log2(p); } return h;
}

export interface Leak { rule: string; start: number; end: number } // [start, end) of the SECRET within the text

/** Secrets gitleaks' rules find in `text`. `path` enables path-scoped rules and the global path allowlist. `skip` excludes rule ids. */
export function findLeaks(text: string, o: { path?: string; skip?: Set<string> } = {}): Leak[] {
  const c = gitleaksRules();
  if (o.path && c.allowPaths.some((r) => r.test(o.path!))) return [];
  const lower = text.toLowerCase(); const out: Leak[] = [];
  for (const r of c.rules) {
    if (o.skip?.has(r.id)) continue;
    if (r.keywords.length && !r.keywords.some((k) => lower.includes(k))) continue;
    if (r.path && !(o.path && r.path.test(o.path))) continue;
    r.re.lastIndex = 0;
    for (let m = r.re.exec(text); m; m = r.re.exec(text)) {
      if (m[0] === "") { r.re.lastIndex++; continue; }
      const gi = r.group ?? (m.length > 1 ? m.findIndex((g, i) => i > 0 && g) : 0);
      const secret = gi > 0 ? m[gi]! : m[0];
      if (!secret) continue;
      const start = m.index + (gi > 0 ? m[0].indexOf(secret) : 0);
      if (r.entropy && shannon(secret) < r.entropy) continue;
      const ls = text.lastIndexOf("\n", m.index) + 1; const le = text.indexOf("\n", m.index + m[0].length); const line = text.slice(ls, le < 0 ? undefined : le);
      const sl = secret.toLowerCase();
      if (c.allowRe.some((a) => a.test(secret)) || c.stop.some((s) => sl.includes(s))) continue;
      const allowed = r.allow.some((a) => {
        const t = a.target === "match" ? m![0] : a.target === "line" ? line : secret;
        const checks = [a.regexes.length ? a.regexes.some((x) => x.test(t)) : undefined, a.stopwords.length ? a.stopwords.some((s) => sl.includes(s)) : undefined, a.paths.length ? !!o.path && a.paths.some((x) => x.test(o.path!)) : undefined].filter((x): x is boolean => x !== undefined);
        return checks.length > 0 && (a.and ? checks.every(Boolean) : checks.some(Boolean));
      });
      if (!allowed) out.push({ rule: r.id, start, end: start + secret.length });
    }
  }
  return out;
}

/** Replace every leak with `[REDACTED:gitleaks:<rule>]` (overlaps merged, first rule wins). */
export function redactLeaks(text: string, o: { path?: string; skip?: Set<string> } = {}): { text: string; rules: string[] } {
  const leaks = findLeaks(text, o).sort((a, b) => a.start - b.start || b.end - a.end);
  if (!leaks.length) return { text, rules: [] };
  let out = ""; let at = 0; const rules: string[] = [];
  for (const l of leaks) { if (l.start < at) continue; out += text.slice(at, l.start) + `[REDACTED:gitleaks:${l.rule}]`; at = l.end; rules.push(l.rule); }
  return { text: out + text.slice(at), rules: [...new Set(rules)] };
}
