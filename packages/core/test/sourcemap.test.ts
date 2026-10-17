import { describe, expect, it } from "vitest";
import { cleanSourcePath, decodeInlineSourceMap, parseSourceMap } from "../src/analyze/sourcemap";

describe("parseSourceMap", () => {
  it("RECOVERS first-party files with hashes and skips vendored sources", async () => {
    const map = {
      version: 3,
      sources: ["webpack://app/./src/App.tsx", "webpack://app/./node_modules/react/index.js", "webpack://app/webpack/bootstrap", "webpack://app/./src/empty.ts"],
      sourcesContent: ["export const App = () => null;", "module.exports = 1", "/*boot*/", null],
    };
    const r = await parseSourceMap(JSON.stringify(map), "https://x.test/app.js.map");
    expect(r.ok).toBe(true);
    expect(r.totalSources).toBe(4);
    expect(r.vendored).toBe(2);
    expect(r.recovered).toBe(1);
    expect(r.withoutContent).toBe(1);
    expect(r.files[0]).toMatchObject({ path: "src/App.tsx", provenance: "recovered", language: "TypeScript" });
    expect(r.files[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.moduleTree).toEqual(["src/App.tsx", "src/empty.ts"]);
  });
  it("neutralises path traversal in source names", async () => {
    const r = await parseSourceMap(JSON.stringify({ version: 3, sources: ["../../../etc/passwd"], sourcesContent: ["x"] }), "o");
    expect(r.files[0]!.path).toBe("etc/passwd");
    expect(r.files[0]!.path).not.toContain("..");
  });
  it("flattens index maps (sections)", async () => {
    const r = await parseSourceMap(JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sources: ["a.ts"], sourcesContent: ["a"] } }, { offset: { line: 9, column: 0 }, map: { version: 3, sources: ["b.ts"], sourcesContent: ["b"] } }] }), "o");
    expect(r.files.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
  });
  it("reports invalid input honestly", async () => {
    expect((await parseSourceMap("nope", "o")).ok).toBe(false);
    expect((await parseSourceMap("{}", "o")).error).toMatch(/Not a source map/);
  });
  it("decodes inline base64 maps", () => {
    const json = JSON.stringify({ version: 3, sources: ["a.js"] });
    expect(decodeInlineSourceMap(`data:application/json;base64,${btoa(json)}`)).toBe(json);
    expect(decodeInlineSourceMap("https://x/y.map")).toBeNull();
  });
  it("cleans bundler schemes", () => {
    expect(cleanSourcePath("webpack://_N_E/./src/a.ts?1a2b")).toBe("src/a.ts");
    expect(cleanSourcePath("src/b.ts", "app")).toBe("app/src/b.ts");
  });
});
