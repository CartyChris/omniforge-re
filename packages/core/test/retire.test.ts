import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { detectLibraries, isAtOrAbove, parseRepository } from "../src/analyze/retire";

const dir = new URL("./fixtures/retire/", import.meta.url);
const read = (f: string) => fs.readFileSync(new URL(f, dir), "utf8");
const raw = JSON.parse(read("jsrepository-excerpt.json"));
const { repo } = parseRepository(raw);

describe("retire.js repository matching (real library files, real vulnerability data excerpt)", () => {
  it("identifies jQuery 1.12.4 from its real minified file and reports exactly the advisories whose ranges contain 1.12.4", () => {
    const found = detectLibraries(repo, [{ url: "https://cdn.example.com/js/app.min.js", content: read("jquery-1.12.4.min.js") }]);
    expect(found).toHaveLength(1);
    const jq = found[0]!;
    expect(jq).toMatchObject({ component: "jquery", npmname: "jquery", version: "1.12.4", detection: "filecontent" });
    const ids = jq.vulnerabilities.flatMap((v) => v.ids);
    expect(ids).toEqual(expect.arrayContaining(["CVE-2015-9251", "CVE-2019-11358", "CVE-2020-11022", "CVE-2020-11023"]));
    // ranges are honoured both ways: every reported advisory contains the version, and none that excludes it is reported
    for (const v of jq.vulnerabilities) {
      if (v.below) expect(isAtOrAbove("1.12.4", v.below), v.summary).toBe(false);
      if (v.atOrAbove) expect(isAtOrAbove("1.12.4", v.atOrAbove), v.summary).toBe(true);
    }
    const all = (raw.jquery.vulnerabilities as { below?: string; atOrAbove?: string }[]).length;
    expect(jq.vulnerabilities.length).toBeLessThan(all);
  });

  it("a fixed version has no advisories from the same data", () => {
    const [jq] = detectLibraries(repo, [{ url: "https://x/jquery.js", content: "/*! jQuery v3.7.1 | (c) OpenJS Foundation and other contributors | jquery.org/license */" }]);
    expect(jq).toMatchObject({ version: "3.7.1" });
    expect(jq!.vulnerabilities.flatMap((v) => v.ids)).not.toContain("CVE-2020-11022");
    expect(jq!.vulnerabilities.every((v) => !v.ids.length || !/CVE-20(1[5-9]|20)/.test(v.ids.join()))).toBe(true);
  });

  it("detects from the URL and file name alone (CDN-hosted libraries have no text to read), and prefers the stronger route", () => {
    const byUri = detectLibraries(repo, [{ url: "https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.4/lodash.min.js" }]);
    expect(byUri).toMatchObject([{ component: "lodash", version: "4.17.4", detection: "uri" }]);
    expect(byUri[0]!.vulnerabilities.flatMap((v) => v.ids).join()).toMatch(/CVE-2018-16487|CVE-2019-10744|CVE-2020-8203/);
    const byName = detectLibraries(repo, [{ url: "https://example.com/static/jquery-1.12.4.min.js" }]);
    expect(byName[0]).toMatchObject({ component: "jquery", version: "1.12.4", detection: "filename" });
    const both = detectLibraries(repo, [{ url: "https://example.com/static/jquery-1.12.4.min.js", content: read("jquery-1.12.4.min.js") }]);
    expect(both).toHaveLength(1); expect(both[0]!.detection).toBe("filecontent");
  });

  it("does not guess: a file with no banner, an unknown file, and a lodash minified file whose only identifier is a hash are not reported", () => {
    expect(detectLibraries(repo, [{ url: "https://example.com/app.js", content: "function a(){return 1}" }])).toEqual([]);
    // retire identifies this real file by SHA-1 (not implemented here), so the honest answer is "not detected", never a guessed version
    expect(detectLibraries(repo, [{ url: "https://example.com/vendor.js", content: read("lodash-4.17.4.min.js") }])).toEqual([]);
  });

  it("version comparison follows retire's rules", () => {
    expect(isAtOrAbove("1.12.4", "1.12.4")).toBe(true);
    expect(isAtOrAbove("1.12.4", "1.12.5")).toBe(false);
    expect(isAtOrAbove("1.9.0", "1.10.0")).toBe(false);          // numeric, not lexical
    expect(isAtOrAbove("1.2", "1.2.0")).toBe(true);              // missing segments count as 0
    expect(isAtOrAbove("3.0.0", "3.0.0-beta1")).toBe(true);     // a release is at or above its own pre-release…
    expect(isAtOrAbove("2.0.0-rc1", "2.0.0")).toBe(false);      // …and a pre-release is below the release
  });

  it("treats the repository as untrusted data: malformed, oversized and catastrophic rules cannot break or stall a scan", () => {
    const bad = parseRepository({
      ok: { extractors: { filecontent: ["Lib v(§§version§§)"] } },
      noExtractors: { vulnerabilities: [] }, junk: 5,
      long: { extractors: { filecontent: ["a".repeat(2000)] } },
      broken: { extractors: { filecontent: ["(unclosed"], uri: ["/(§§version§§)/broken\\.js"] } },
      evil: { extractors: { filecontent: ["(a+)+$(§§version§§)"] } },
    });
    expect(Object.keys(bad.repo).sort()).toEqual(["broken", "ok"]);
    expect(bad.dropped).toBe(4); // two malformed components, the 2000-character rule and the nested-quantifier rule
    const t = Date.now();
    const r = detectLibraries(bad.repo, [{ url: "https://x/1.2.3/broken.js", content: "Lib v9.9.9\n" + "a".repeat(600_000) + "!" }]);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.map((x) => `${x.component}@${x.version}`).sort()).toEqual(["broken@1.2.3", "ok@9.9.9"]);
    expect(() => parseRepository([])).toThrow(/Not a retire\.js repository/);
    expect(() => parseRepository({})).toThrow(/no usable detection rules/);
  });

  it("rejects implausible version strings from a rule (no injection of arbitrary text into findings)", () => {
    const { repo: r } = parseRepository({ x: { extractors: { filecontent: ["ver=(.+)"] } } });
    expect(detectLibraries(r, [{ url: "https://x/a.js", content: "ver=<script>alert(1)</script>" }])).toEqual([]);
  });
});

// Opt-in: scan adversarial text with EVERY rule of the full, current repository (OMNIFORGE_RETIRE_REPO=/path/to/jsrepository.json).
describe.skipIf(!process.env.OMNIFORGE_RETIRE_REPO)("full repository", () => {
  it("parses, and every rule finishes quickly on large minified-looking input", () => {
    const full = parseRepository(JSON.parse(fs.readFileSync(process.env.OMNIFORGE_RETIRE_REPO!, "utf8")));
    expect(full.components).toBeGreaterThan(50);
    expect(full.dropped).toBe(0); // the screen must not discard any genuine rule
    const text = (read("jquery-1.12.4.min.js") + read("lodash-4.17.4.min.js")).repeat(3);
    const t = Date.now(); const found = detectLibraries(full.repo, [{ url: "https://x/bundle.js", content: text }]); const ms = Date.now() - t;
    expect(found.some((f) => f.component === "jquery" && f.version === "1.12.4")).toBe(true);
    expect(ms).toBeLessThan(5000);
  });
});
