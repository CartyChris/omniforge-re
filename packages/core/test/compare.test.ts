import { describe, expect, it } from "vitest";
import { compareInvestigations, matchFeatures } from "../src/analyze/compare";

const feat = (name: string, category = "ui") => ({ id: name, name, category, description: "", pages: [], files: [], evidence: [], confidence: 0.8, provenance: "inferred", spec: {} }) as any;
const inv = (o: any) => ({ id: o.id, name: o.name, pages: [], technologies: [], dependencies: [], endpoints: [], features: [], findings: [], files: [], evidence: [], routes: [], thirdParties: [], coverage: { score: 0.5 }, ...o }) as any;

describe("compareInvestigations", () => {
  const a = inv({ id: "a", name: "Site A", pages: [{ url: "https://a.test/" }, { url: "https://a.test/about/" }, { url: "https://a.test/pricing" }], technologies: [{ name: "React", version: "18.2.0" }, { name: "Stripe" }], dependencies: [{ name: "left-pad", version: "1.0.0", ecosystem: "npm" }, { name: "lodash", version: "4.17.20", ecosystem: "npm" }], endpoints: [{ url: "https://a.test/api/users", method: "get" }], thirdParties: [{ host: "cdn.x.com" }, { host: "stripe.com" }], features: [feat("Site navigation"), feat("Checkout form", "commerce")], findings: [{ area: "security" }, { area: "seo" }], coverage: { score: 0.9 } });
  const b = inv({ id: "b", name: "Site B", pages: [{ url: "https://b.test/" }, { url: "https://b.test/about" }, { url: "https://b.test/blog" }], technologies: [{ name: "React", version: "19.0.0" }, { name: "Vue" }], dependencies: [{ name: "lodash", version: "4.17.21", ecosystem: "npm" }, { name: "lodash", version: "x", ecosystem: "pypi" }], endpoints: [{ url: "https://b.test/api/users", method: "GET" }, { url: "https://b.test/api/posts", method: "GET" }], thirdParties: [{ host: "cdn.x.com" }], features: [feat("Navigation of the site"), feat("Blog list")], findings: [{ area: "seo" }], coverage: { score: 0.6 } });
  const c = compareInvestigations(a, b);
  it("diffs routes by path, ignoring origin and trailing slash", () => {
    expect(c.routes.both).toEqual(["/", "/about"]);
    expect(c.routes.onlyA).toEqual(["/pricing"]); expect(c.routes.onlyB).toEqual(["/blog"]);
    expect(c.routes.overlap).toBeCloseTo(2 / 4);
  });
  it("diffs the stack and reports version differences for shared technologies", () => {
    expect(c.stack.both).toEqual(["React"]); expect(c.stack.onlyA).toEqual(["Stripe"]); expect(c.stack.onlyB).toEqual(["Vue"]);
    expect(c.stack.versionDiffs).toEqual([{ name: "React", a: "18.2.0", b: "19.0.0" }]);
  });
  it("keys dependencies by ecosystem+name and flags version drift", () => {
    expect(c.dependencies.both).toEqual(["npm:lodash"]); expect(c.dependencies.onlyB).toEqual(["pypi:lodash"]);
    expect(c.dependencies.versionDiffs).toEqual([{ name: "lodash", a: "4.17.20", b: "4.17.21" }]);
  });
  it("normalises endpoint method case and origin; third parties by host", () => {
    expect(c.endpoints.both).toEqual(["GET /api/users"]); expect(c.endpoints.onlyB).toEqual(["GET /api/posts"]);
    expect(c.thirdParties).toMatchObject({ both: ["cdn.x.com"], onlyA: ["stripe.com"], onlyB: [] });
  });
  it("matches features by name tokens within a category, one-to-one", () => {
    expect(c.features.matched.map((m) => [m.a.name, m.b.name, m.how])).toEqual([["Site navigation", "Navigation of the site", "same-name"]]);
    expect(c.features.onlyA.map((f) => f.name)).toEqual(["Checkout form"]); expect(c.features.onlyB.map((f) => f.name)).toEqual(["Blog list"]);
    const m = matchFeatures([feat("User profile settings")], [feat("Profile settings page")]);
    expect(m.matched[0]!.how).toBe("similar-name");
    expect(matchFeatures([feat("Search", "ui")], [feat("Search", "data")]).matched.map((x) => x.how)).toEqual(["same-name"]);
    expect(matchFeatures([feat("Search results", "ui")], [feat("Search results page", "data")]).matched).toHaveLength(0); // similar (not identical) names need the same category
  });
  it("reports findings by area, totals and coverage", () => {
    expect(c.findings).toEqual([{ area: "security", a: 1, b: 0 }, { area: "seo", a: 1, b: 1 }]);
    expect(c.totals.find((t) => t.label === "pages")).toEqual({ label: "pages", a: 3, b: 3 });
    expect(c.coverage).toEqual({ a: 0.9, b: 0.6 });
  });
  it("two empty investigations fully overlap and never divide by zero", () => {
    const e = compareInvestigations(inv({ id: "1", name: "x" }), inv({ id: "2", name: "y" }));
    expect(e.routes.overlap).toBe(1); expect(e.features.overlap).toBe(1);
  });
});
