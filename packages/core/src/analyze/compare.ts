/**
 * Side-by-side comparison of two investigations (two websites, two apps, or two versions of one). Everything is derived from the
 * recorded data — set differences over stack, features, routes, endpoints, dependencies and third parties — so each row can be traced
 * back to evidence. There is deliberately no single "similarity score": the dimensions have no honest common scale.
 */
import type { Feature, Investigation } from "../schema.js";

export interface SetDiff { onlyA: string[]; onlyB: string[]; both: string[]; overlap: number }
export interface FeatureMatch { a: Feature; b: Feature; how: "same-name" | "similar-name" }
export interface InvestigationComparison {
  a: { id: string; name: string }; b: { id: string; name: string };
  stack: SetDiff & { versionDiffs: { name: string; a?: string; b?: string }[] };
  features: { matched: FeatureMatch[]; onlyA: Feature[]; onlyB: Feature[]; overlap: number };
  routes: SetDiff; endpoints: SetDiff; dependencies: SetDiff & { versionDiffs: { name: string; a?: string; b?: string }[] }; thirdParties: SetDiff;
  findings: { area: string; a: number; b: number }[];
  totals: { label: string; a: number; b: number }[];
  coverage: { a: number; b: number };
}

const diff = (a: Iterable<string>, b: Iterable<string>): SetDiff => {
  const A = new Set(a), B = new Set(b);
  const both = [...A].filter((x) => B.has(x)).sort();
  const onlyA = [...A].filter((x) => !B.has(x)).sort(), onlyB = [...B].filter((x) => !A.has(x)).sort();
  const union = A.size + B.size - both.length;
  return { onlyA, onlyB, both, overlap: union ? both.length / union : 1 };
};
const pathOf = (u: string) => { try { return new URL(u, "http://x").pathname.replace(/\/+$/, "") || "/"; } catch { return u; } };
const STOP = new Set(["the", "a", "an", "and", "of", "for", "to", "with", "in", "on"]);
const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t && !STOP.has(t)));
const jac = (x: Set<string>, y: Set<string>) => { const i = [...x].filter((t) => y.has(t)).length; const u = x.size + y.size - i; return u ? i / u : 0; };

/** Greedy best-match by feature name (exact normalised name, or token overlap ≥ 0.5 within the same category). A name match is not proof of equal behaviour. */
export function matchFeatures(fa: Feature[], fb: Feature[]) {
  const pairs: { i: number; j: number; s: number }[] = [];
  fa.forEach((a, i) => fb.forEach((b, j) => {
    const ta = tokens(a.name), tb = tokens(b.name);
    const same = [...ta].sort().join(" ") === [...tb].sort().join(" ");
    const s = same ? 1 : a.category === b.category ? jac(ta, tb) : 0; // an identical name is a match in any category; a merely similar one must share the category
    if (s >= 0.5) pairs.push({ i, j, s });
  }));
  pairs.sort((p, q) => q.s - p.s);
  const ui = new Set<number>(), uj = new Set<number>(), matched: FeatureMatch[] = [];
  for (const p of pairs) { if (ui.has(p.i) || uj.has(p.j)) continue; ui.add(p.i); uj.add(p.j); matched.push({ a: fa[p.i]!, b: fb[p.j]!, how: p.s === 1 ? "same-name" : "similar-name" }); }
  return { matched, onlyA: fa.filter((_, i) => !ui.has(i)), onlyB: fb.filter((_, j) => !uj.has(j)) };
}

const versions = <T extends { name: string; version?: string }>(a: T[], b: T[], key: (x: T) => string = (x) => x.name.toLowerCase()) => {
  const vb = new Map(b.map((x) => [key(x), x.version]));
  return a.flatMap((x) => { const v = vb.get(key(x)); return x.version && v && x.version !== v ? [{ name: x.name, a: x.version, b: v }] : []; });
};

export function compareInvestigations(a: Investigation, b: Investigation): InvestigationComparison {
  const m = matchFeatures(a.features, b.features);
  const un = a.features.length + b.features.length - m.matched.length;
  const dk = (d: Investigation["dependencies"][number]) => `${d.ecosystem}:${d.name.toLowerCase()}`;
  const ek = (e: Investigation["endpoints"][number]) => `${(e.method ?? "*").toUpperCase()} ${pathOf(e.url)}`;
  const routes = (i: Investigation) => [...i.pages.map((p) => pathOf(p.url)), ...(i.routes ?? []).map((r) => pathOf(r.route))];
  const areas = [...new Set([...a.findings, ...b.findings].map((f) => f.area))].sort();
  const stats = (i: Investigation) => ({ pages: i.pages.length, files: i.files.length, features: i.features.length, endpoints: i.endpoints.length, dependencies: i.dependencies.length, technologies: i.technologies.length, evidence: i.evidence.length, findings: i.findings.length });
  const sa = stats(a), sb = stats(b);
  return {
    a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name },
    stack: { ...diff(a.technologies.map((t) => t.name), b.technologies.map((t) => t.name)), versionDiffs: versions(a.technologies, b.technologies) },
    features: { ...m, overlap: un ? m.matched.length / un : 1 },
    routes: diff(routes(a), routes(b)), endpoints: diff(a.endpoints.map(ek), b.endpoints.map(ek)),
    dependencies: { ...diff(a.dependencies.map(dk), b.dependencies.map(dk)), versionDiffs: versions(a.dependencies, b.dependencies, (d) => `${d.ecosystem}:${d.name.toLowerCase()}`) },
    thirdParties: diff((a.thirdParties ?? []).map((t) => t.host), (b.thirdParties ?? []).map((t) => t.host)),
    findings: areas.map((area) => ({ area, a: a.findings.filter((f) => f.area === area).length, b: b.findings.filter((f) => f.area === area).length })),
    totals: (Object.keys(sa) as (keyof typeof sa)[]).map((k) => ({ label: k, a: sa[k], b: sb[k] })),
    coverage: { a: a.coverage.score, b: b.coverage.score },
  };
}
