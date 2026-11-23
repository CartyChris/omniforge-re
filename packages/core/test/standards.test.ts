import { describe, expect, it } from "vitest";
import { analyzeTechnicalArtifacts, toCycloneDX, toPurl, toSarif, type Dependency, type Investigation } from "../src/index";

const deps: Dependency[] = [
  { name: "react", version: "18.3.1", ecosystem: "npm", source: "package.json" },
  { name: "@angular/core", version: "17.0.0", ecosystem: "npm", source: "package.json", dev: true },
  { name: "Django_Rest", version: "3.14.0", ecosystem: "pypi", source: "requirements.txt" },
  { name: "serde", version: "1.0.190", ecosystem: "cargo", source: "Cargo.toml" },
  { name: "github.com/gorilla/mux", version: "v1.8.0", ecosystem: "go", source: "go.mod" },
  { name: "org.apache.commons:commons-lang3", version: "3.12.0", ecosystem: "maven", source: "pom.xml" },
  { name: "Newtonsoft.Json", version: "13.0.3", ecosystem: "nuget", source: "app.csproj" },
  { name: "rails", version: "7.1.2", ecosystem: "gem", source: "Gemfile.lock" },
  { name: "laravel/framework", version: "10.0.0", ecosystem: "composer", source: "composer.json" },
];

const inv = {
  id: "inv1", name: "Demo", startedAt: "2026-01-01T00:00:00Z", dependencies: deps,
  evidence: [
    { id: "ev1", kind: "observed", method: "http-get", source: "https://example.test/", timestamp: "t", confidence: 1, summary: "s" },
    { id: "ev2", kind: "observed", method: "header-match", source: "src/app.js", timestamp: "t", confidence: 1, summary: "s" },
  ],
  findings: [
    { id: "f1", area: "security", severity: "high", title: "Secret in bundle", detail: "d1", evidence: ["ev1", "ev2"] },
    { id: "f2", area: "performance", severity: "medium", title: "Slow", detail: "d2", evidence: ["ev1"] },
    { id: "f3", area: "seo", severity: "low", title: "No meta", detail: "d3", evidence: [] },
    { id: "f4", area: "quality", severity: "info", title: "Note", detail: "d4", evidence: ["missing"] },
  ],
} as unknown as Investigation;

describe("toPurl", () => {
  it("builds correct purls for each ecosystem", () => {
    expect(deps.map(toPurl)).toEqual([
      "pkg:npm/react@18.3.1",
      "pkg:npm/%40angular/core@17.0.0",
      "pkg:pypi/django-rest@3.14.0",
      "pkg:cargo/serde@1.0.190",
      "pkg:golang/github.com/gorilla/mux@v1.8.0",
      "pkg:maven/org.apache.commons/commons-lang3@3.12.0",
      "pkg:nuget/Newtonsoft.Json@13.0.3",
      "pkg:gem/rails@7.1.2",
      "pkg:composer/laravel/framework@10.0.0",
    ]);
    expect(toPurl({ name: "x", ecosystem: "other" })).toBeUndefined();
    expect(toPurl({ name: "lodash", ecosystem: "npm" })).toBe("pkg:npm/lodash");
  });
});

describe("toCycloneDX", () => {
  const bom = toCycloneDX(inv) as any;
  it("has CycloneDX 1.5 top-level fields", () => {
    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe("1.5");
    expect(bom.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(bom.metadata.component.name).toBe("Demo");
    expect(bom.components).toHaveLength(deps.length);
  });
  it("round-trips through OmniForge's own SBOM ingestion", () => {
    const res = analyzeTechnicalArtifacts([{ path: "bom.json", data: new TextEncoder().encode(JSON.stringify(bom)) }]);
    expect(res.found.map((f) => f.kind)).toEqual(["sbom"]);
    const norm = (d: Dependency) => `${d.ecosystem}|${d.name}|${d.version}`;
    expect(res.dependencies.map(norm).sort()).toEqual(deps.map(norm).sort());
  });
});

describe("toSarif", () => {
  const s = toSarif(inv) as any;
  it("has SARIF 2.1.0 required fields and one result per finding", () => {
    expect(s.version).toBe("2.1.0");
    expect(s.$schema).toMatch(/sarif-2\.1\.0/);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0].tool.driver.name).toBe("OmniForge");
    expect(s.runs[0].results).toHaveLength(inv.findings.length);
    for (const r of s.runs[0].results) {
      expect(typeof r.ruleId).toBe("string");
      expect(typeof r.message.text).toBe("string");
      expect(s.runs[0].tool.driver.rules.some((x: any) => x.id === r.ruleId)).toBe(true);
    }
  });
  it("maps severity to level and evidence sources to locations", () => {
    const rs = s.runs[0].results;
    expect(rs.map((r: any) => r.level)).toEqual(["error", "warning", "note", "none"]);
    expect(rs[0].locations.map((l: any) => l.physicalLocation.artifactLocation.uri)).toEqual(["https://example.test/", "src/app.js"]);
    expect(rs[2].locations).toEqual([]);
    expect(rs[3].locations).toEqual([]);
  });
});
