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

const rx = ([s, f]: Pat, g = false): RegExp | null => { try { return new RegExp(s, f + (g ? "gd" : "")); } catch { return null; } };

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

/** A raw rule match before policy: rule index into `gitleaksRules().rules`, the whole match and the secret, as UTF-16 offsets. */
export interface Candidate { rule: number; start: number; end: number; sStart: number; sEnd: number }

/** A faster candidate finder (the Rust/WebAssembly engine). Returns null when it cannot scan this text (the JS path is used). */
export interface SecretScanEngine { name: string; candidates(text: string): Candidate[] | null; /** rule indices the engine could not compile — the JS path covers them */ failed: Set<number> }
let engine: SecretScanEngine | null = null;
/** Install (or remove) the native engine. Results are identical by contract; only speed differs (see gitleaks-engine tests). */
export function setSecretScanEngine(e: SecretScanEngine | null) { engine = e; }
export const secretScanEngineName = () => engine?.name ?? "js";

let kwIndex: { re: RegExp; byKeyword: Map<string, number[]>; always: number[] } | undefined;
/** One pass over the lowercased text finds every rule keyword (instead of one substring search per keyword per rule). */
function keywordIndex(rules: Compiled[]) {
  if (kwIndex) return kwIndex;
  const byKeyword = new Map<string, number[]>(); const always: number[] = [];
  rules.forEach((r, i) => { if (!r.keywords.length) always.push(i); for (const k of r.keywords) byKeyword.set(k, [...(byKeyword.get(k) ?? []), i]); });
  const alts = [...byKeyword.keys()].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return (kwIndex = { re: new RegExp(`(?=(${alts.join("|")}))`, "g"), byKeyword, always });
}

/** The pure-JS candidate finder (also the reference the native engine is tested against). */
export function jsCandidates(text: string, only?: Set<number>): Candidate[] {
  const c = gitleaksRules(); const ki = keywordIndex(c.rules);
  const active = new Set<number>(ki.always);
  const lower = text.toLowerCase();
  // overlapping keyword search: a zero-width lookahead at every position reports each keyword that starts there
  ki.re.lastIndex = 0;
  for (let m = ki.re.exec(lower); m; m = ki.re.exec(lower)) {
    for (const k of ki.byKeyword.keys()) if (lower.startsWith(k, m.index)) for (const r of ki.byKeyword.get(k)!) active.add(r);
    ki.re.lastIndex = m.index + 1;
  }
  const out: Candidate[] = [];
  for (const i of [...active].sort((a, b) => a - b)) {
    if (only && !only.has(i)) continue;
    const r = c.rules[i]!; r.re.lastIndex = 0;
    for (let m = r.re.exec(text); m; m = r.re.exec(text)) {
      if (m[0] === "") { r.re.lastIndex++; continue; }
      const gi = r.group ?? (m.length > 1 ? m.findIndex((g, j) => j > 0 && g) : 0);
      if (gi < 0) { out.push({ rule: i, start: m.index, end: m.index + m[0].length, sStart: m.index, sEnd: m.index + m[0].length }); continue; }
      const span = gi > 0 ? m.indices?.[gi] : [m.index, m.index + m[0].length];
      if (!span || span[0] === span[1]) continue;
      out.push({ rule: i, start: m.index, end: m.index + m[0].length, sStart: span[0]!, sEnd: span[1]! });
    }
  }
  return out;
}

/** Secrets gitleaks' rules find in `text`. `path` enables path-scoped rules and the global path allowlist. `skip` excludes rule ids. */
export function findLeaks(text: string, o: { path?: string; skip?: Set<string> } = {}): Leak[] {
  const c = gitleaksRules();
  if (o.path && c.allowPaths.some((r) => r.test(o.path!))) return [];
  let cands = engine?.candidates(text) ?? null;
  if (cands && engine!.failed.size) cands = [...cands, ...jsCandidates(text, engine!.failed)];
  return applyPolicy(text, cands ?? jsCandidates(text), o);
}

/** Path scope, entropy floors, stopwords and allowlists — the same policy whichever engine found the candidates. */
export function applyPolicy(text: string, cands: Candidate[], o: { path?: string; skip?: Set<string> } = {}): Leak[] {
  const c = gitleaksRules(); const out: Leak[] = [];
  for (const k of cands) {
    const r = c.rules[k.rule]!;
    if (o.skip?.has(r.id)) continue;
    if (r.path && !(o.path && r.path.test(o.path))) continue;
    const secret = text.slice(k.sStart, k.sEnd); const match = text.slice(k.start, k.end);
    if (r.entropy && shannon(secret) < r.entropy) continue;
    const ls = text.lastIndexOf("\n", k.start) + 1; const le = text.indexOf("\n", k.end); const line = text.slice(ls, le < 0 ? undefined : le);
    const sl = secret.toLowerCase();
    if (c.allowRe.some((a) => a.test(secret)) || c.stop.some((s) => sl.includes(s))) continue;
    const allowed = r.allow.some((a) => {
      const t = a.target === "match" ? match : a.target === "line" ? line : secret;
      const checks = [a.regexes.length ? a.regexes.some((x) => x.test(t)) : undefined, a.stopwords.length ? a.stopwords.some((s) => sl.includes(s)) : undefined, a.paths.length ? !!o.path && a.paths.some((x) => x.test(o.path!)) : undefined].filter((x): x is boolean => x !== undefined);
      return checks.length > 0 && (a.and ? checks.every(Boolean) : checks.some(Boolean));
    });
    if (!allowed) out.push({ rule: r.id, start: k.sStart, end: k.sEnd });
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end || a.rule.localeCompare(b.rule));
}

/** Replace every leak with `[REDACTED:gitleaks:<rule>]` (overlaps merged, first rule wins). */
export function redactLeaks(text: string, o: { path?: string; skip?: Set<string> } = {}): { text: string; rules: string[] } {
  const leaks = findLeaks(text, o).sort((a, b) => a.start - b.start || b.end - a.end);
  if (!leaks.length) return { text, rules: [] };
  let out = ""; let at = 0; const rules: string[] = [];
  for (const l of leaks) { if (l.start < at) continue; out += text.slice(at, l.start) + `[REDACTED:gitleaks:${l.rule}]`; at = l.end; rules.push(l.rule); }
  return { text: out + text.slice(at), rules: [...new Set(rules)] };
}
