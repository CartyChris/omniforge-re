/**
 * Standard machine-readable exports of an investigation:
 *  - CycloneDX 1.5 JSON BOM of the recovered dependencies
 *  - SARIF 2.1.0 JSON of the findings
 * Both are deterministic projections of the investigation; nothing is inferred.
 */
import type { Dependency, Finding, Investigation } from "../schema.js";

const PURL_TYPE: Partial<Record<Dependency["ecosystem"], string>> = {
  npm: "npm", pypi: "pypi", cargo: "cargo", go: "golang", maven: "maven", nuget: "nuget", gem: "gem", composer: "composer", swift: "swift",
};

const enc = (s: string) => encodeURIComponent(s);
const segs = (s: string) => s.split("/").filter(Boolean).map(enc).join("/");

/** Package URL (purl) for a dependency, or undefined when the ecosystem has no purl type. */
export function toPurl(d: Pick<Dependency, "name" | "version" | "ecosystem">): string | undefined {
  const type = PURL_TYPE[d.ecosystem];
  if (!type || !d.name) return undefined;
  let path: string;
  switch (d.ecosystem) {
    case "npm": {
      const m = d.name.match(/^(@[^/]+)\/(.+)$/);
      path = m ? `${enc(m[1]!)}/${enc(m[2]!)}` : enc(d.name);
      break;
    }
    case "pypi": path = enc(d.name.toLowerCase().replace(/[_.]+/g, "-")); break;
    case "maven": {
      const [g, a] = d.name.includes(":") ? d.name.split(":") : ["", d.name];
      path = g ? `${enc(g)}/${enc(a!)}` : enc(a!);
      break;
    }
    case "composer": path = segs(d.name.toLowerCase()); break;
    case "go": case "swift": path = segs(d.name); break;
    default: path = enc(d.name);
  }
  return `pkg:${type}/${path}${d.version ? `@${enc(d.version)}` : ""}`;
}

function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const TOOL = { name: "OmniForge", vendor: "OmniForge", version: "1.0.0" };

/** CycloneDX 1.5 JSON BOM of the investigation's dependencies. */
export function toCycloneDX(inv: Investigation): Record<string, unknown> {
  const seen = new Set<string>();
  const components: Record<string, unknown>[] = [];
  for (const d of inv.dependencies ?? []) {
    const purl = toPurl(d);
    const key = purl ?? `${d.ecosystem}:${d.name}@${d.version ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const c: Record<string, unknown> = { type: "library", "bom-ref": key, name: d.name };
    if (d.version) c.version = d.version;
    if (purl) c.purl = purl;
    if (d.dev) c.scope = "optional";
    c.properties = [{ name: "omniforge:ecosystem", value: d.ecosystem }, { name: "omniforge:source", value: d.source }];
    components.push(c);
  }
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${uuid()}`,
    version: 1,
    metadata: {
      timestamp: inv.finishedAt ?? inv.startedAt ?? new Date().toISOString(),
      tools: { components: [{ type: "application", name: TOOL.name, version: TOOL.version }] },
      component: { type: "application", "bom-ref": `omniforge:${inv.id}`, name: inv.name },
    },
    components,
  };
}

/** SARIF level for a finding severity. */
export function sarifLevel(s: Finding["severity"]): "error" | "warning" | "note" | "none" {
  return s === "high" ? "error" : s === "medium" ? "warning" : s === "low" ? "note" : "none";
}

const ruleSlug = (f: Finding) => `${f.area}/${f.title.toLowerCase().replace(/\d+/g, "").replace(/[^a-z]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "finding"}`;

/** SARIF 2.1.0 JSON log with one result per finding. */
export function toSarif(inv: Investigation): Record<string, unknown> {
  const evById = new Map((inv.evidence ?? []).map((e) => [e.id, e]));
  const rules = new Map<string, Record<string, unknown>>();
  const results = (inv.findings ?? []).map((f) => {
    const ruleId = ruleSlug(f);
    if (!rules.has(ruleId)) rules.set(ruleId, { id: ruleId, name: f.title, shortDescription: { text: f.title }, properties: { area: f.area } });
    const sources = [...new Set(f.evidence.map((id) => evById.get(id)?.source).filter((s): s is string => !!s))];
    return {
      ruleId,
      level: sarifLevel(f.severity),
      message: { text: f.detail ? `${f.title}: ${f.detail}` : f.title },
      locations: sources.map((uri) => ({ physicalLocation: { artifactLocation: { uri } } })),
      properties: { severity: f.severity, area: f.area, findingId: f.id, evidence: f.evidence },
    };
  });
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: TOOL.name, version: TOOL.version, rules: [...rules.values()] } },
      results,
      properties: { investigation: inv.name, investigationId: inv.id },
    }],
  };
}
