import { describe, expect, it } from "vitest";
import { checkVulnerabilities, checkable, isExactVersion, type Dependency } from "../src/index";

const dep = (name: string, version: string | undefined, ecosystem: Dependency["ecosystem"] = "npm", source = "package-lock.json"): Dependency => ({ name, version, ecosystem, source });

describe("OSV check", () => {
  it("only checks exact versions (ranges say nothing about what is installed)", () => {
    expect(isExactVersion("1.2.3")).toBe(true); expect(isExactVersion("v2.0.0-beta.1")).toBe(true);
    for (const r of ["^1.2.3", "~1.2", ">=1", "*", "latest", "1.x", undefined, ""]) expect(isExactVersion(r as string | undefined), String(r)).toBe(false);
    const list = checkable([dep("a", "1.0.0"), dep("a", "1.0.0"), dep("b", "^2.0.0"), dep("c", "3.0.0", "other")]);
    expect(list.map((d) => d.name)).toEqual(["a"]); // deduplicated; range and unsupported ecosystem excluded
  });

  it("queries OSV in a batch, then reads advisory details for severity and fixed versions", async () => {
    const calls: { url: string; body?: any }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/v1/querybatch")) return new Response(JSON.stringify({ results: [{ vulns: [{ id: "GHSA-aaaa-bbbb-cccc" }] }, {}, { vulns: [{ id: "PYSEC-1" }] }] }), { status: 200 });
      if (url.includes("GHSA-aaaa")) return new Response(JSON.stringify({ id: "GHSA-aaaa-bbbb-cccc", summary: "Prototype pollution in lodash", aliases: ["CVE-2020-8203"], database_specific: { severity: "HIGH" }, affected: [{ package: { name: "lodash" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.20" }] }] }] }), { status: 200 });
      return new Response(JSON.stringify({ id: "PYSEC-1", details: "Bad thing\nmore", database_specific: { severity: "MODERATE" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await checkVulnerabilities([dep("lodash", "4.17.15"), dep("left-pad", "1.3.0"), dep("django", "3.0.0", "pypi", "requirements.txt"), dep("react", "^18.0.0")], { fetch: fakeFetch });
    expect(r.checked).toBe(3); expect(r.skipped).toBe(1);
    expect(calls[0]!.body.queries).toEqual([{ package: { name: "lodash", ecosystem: "npm" }, version: "4.17.15" }, { package: { name: "left-pad", ecosystem: "npm" }, version: "1.3.0" }, { package: { name: "django", ecosystem: "PyPI" }, version: "3.0.0" }]);
    expect(r.items.map((i) => [i.package, i.severity])).toEqual([["lodash", "high"], ["django", "medium"]]);
    expect(r.items[0]).toMatchObject({ ids: ["CVE-2020-8203", "GHSA-aaaa-bbbb-cccc"], fixed: ["4.17.20"], summary: "Prototype pollution in lodash" });
  });

  it("reports a failing service honestly instead of returning an empty (clean-looking) result", async () => {
    const down = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(checkVulnerabilities([dep("a", "1.0.0")], { fetch: down })).rejects.toThrow(/HTTP 503/);
  });
});
