/**
 * Known-vulnerability check against OSV.dev (the open vulnerability database behind osv-scanner).
 *
 * Only dependencies with an EXACT version (lockfiles, pins, SBOM components) are checked: a range such as "^1.2.0" does not say
 * which version is installed, so reporting vulnerabilities for it would be a guess. Those are counted as `skipped`.
 * This sends package names and versions to api.osv.dev, so callers must make it an explicit user action (never in local-only mode).
 */
import type { Dependency, Vulnerability } from "../schema.js";
import { ProviderError } from "../ai/types.js";

const ECO: Partial<Record<Dependency["ecosystem"], string>> = { npm: "npm", pypi: "PyPI", cargo: "crates.io", go: "Go", maven: "Maven", nuget: "NuGet", gem: "RubyGems", composer: "Packagist" };
const EXACT = /^v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/;

export interface OsvOptions { fetch?: typeof fetch; api?: string; signal?: AbortSignal; maxDetails?: number }

export const isExactVersion = (v?: string) => !!v && EXACT.test(v.trim());

export function checkable(deps: Dependency[]): Dependency[] {
  const seen = new Set<string>(); const out: Dependency[] = [];
  for (const d of deps) {
    if (!ECO[d.ecosystem] || !isExactVersion(d.version)) continue;
    const k = `${d.ecosystem}:${d.name}@${d.version}`; if (seen.has(k)) continue; seen.add(k); out.push(d);
  }
  return out;
}

const sevOf = (v: any): Vulnerability["severity"] => {
  const db = String(v?.database_specific?.severity ?? "").toLowerCase();
  if (["critical", "high", "low"].includes(db)) return db as Vulnerability["severity"];
  if (db === "moderate" || db === "medium") return "medium";
  for (const s of v?.severity ?? []) { const m = String(s.score ?? "").match(/CVSS:[\d.]+\/.*?\bAV:/) ? Number(s.score_num) : NaN; if (!Number.isNaN(m)) return m >= 9 ? "critical" : m >= 7 ? "high" : m >= 4 ? "medium" : "low"; }
  return "unknown";
};

export async function checkVulnerabilities(deps: Dependency[], o: OsvOptions = {}): Promise<{ items: Vulnerability[]; checked: number; skipped: number }> {
  const f = o.fetch ?? fetch; const api = (o.api ?? "https://api.osv.dev").replace(/\/$/, "");
  const list = checkable(deps).slice(0, 3000); const skipped = new Set(deps.map((d) => `${d.ecosystem}:${d.name}`)).size - new Set(list.map((d) => `${d.ecosystem}:${d.name}`)).size;
  const hits: { dep: Dependency; ids: string[] }[] = [];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const res = await f(`${api}/v1/querybatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: ECO[d.ecosystem] }, version: d.version!.replace(/^v/, "") })) }), signal: o.signal });
    if (!res.ok) throw new ProviderError(`OSV.dev answered HTTP ${res.status}`, res.status, "osv");
    const j = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
    (j.results ?? []).forEach((r, k) => { const ids = (r.vulns ?? []).map((v) => v.id); if (ids.length) hits.push({ dep: chunk[k]!, ids }); });
  }
  const detailCache = new Map<string, any>(); let budget = o.maxDetails ?? 60;
  const items: Vulnerability[] = [];
  for (const h of hits) {
    let sev: Vulnerability["severity"] = "unknown"; let summary = ""; const fixed = new Set<string>(); const aliases = new Set<string>(h.ids);
    for (const id of h.ids.slice(0, 6)) {
      if (!detailCache.has(id) && budget-- > 0) { try { const r = await f(`${api}/v1/vulns/${encodeURIComponent(id)}`, { signal: o.signal }); detailCache.set(id, r.ok ? await r.json() : null); } catch { detailCache.set(id, null); } }
      const v = detailCache.get(id); if (!v) continue;
      summary ||= String(v.summary ?? v.details ?? "").split("\n")[0]!.slice(0, 200);
      const s = sevOf(v); const rank = ["unknown", "low", "medium", "high", "critical"]; if (rank.indexOf(s) > rank.indexOf(sev)) sev = s;
      for (const a of v.aliases ?? []) aliases.add(String(a));
      for (const aff of v.affected ?? []) if (aff?.package?.name === h.dep.name) for (const r of aff.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) fixed.add(String(e.fixed));
    }
    items.push({ package: h.dep.name, version: h.dep.version!, ecosystem: h.dep.ecosystem, ids: [...aliases].sort().slice(0, 12), severity: sev, summary: summary || "See the advisory for details", fixed: [...fixed].slice(0, 5), source: h.dep.source });
  }
  const order = ["critical", "high", "medium", "low", "unknown"];
  items.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.package.localeCompare(b.package));
  return { items, checked: list.length, skipped: Math.max(0, skipped) };
}
