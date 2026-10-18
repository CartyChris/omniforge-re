import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM scripts shared with CI
import { acceptable, evaluate, policy } from "../../../scripts/license-audit.mjs";
// @ts-expect-error plain ESM script
import { scan } from "../../../scripts/check-bundle.mjs";

describe("licence policy", () => {
  it("accepts permissive licences and OR-expressions with at least one allowed side", () => {
    for (const l of ["MIT", "ISC", "Apache-2.0", "(MIT OR GPL-3.0)", "Apache-2.0 OR MIT", "(MPL-2.0 OR Apache-2.0)", "BSD-3-Clause AND MIT"]) expect(acceptable(l, policy.allowed), l).toBe(true);
  });
  it("rejects copyleft, source-available, non-commercial, unknown and unparsable licences", () => {
    for (const l of ["GPL-3.0", "AGPL-3.0-only", "LGPL-3.0-or-later", "MPL-2.0", "FSL-1.1-MIT", "BUSL-1.1", "SSPL-1.0", "CC-BY-NC-4.0", "Unknown", "SEE LICENSE IN LICENSE.md", "(GPL-3.0 AND MIT)", "MIT/Apache-2.0", ""]) expect(acceptable(l, policy.allowed), l).toBe(false);
  });
});

describe("evaluate", () => {
  const groups = { MIT: [{ name: "a", versions: ["1"] }], "GPL-3.0": [{ name: "g", versions: ["2"] }], Unknown: [{ name: "@codesandbox/nodebox", versions: ["0.1.8"] }] };
  it("flags every production package with a disallowed licence", () => {
    const r = evaluate({ MIT: groups.MIT, "GPL-3.0": groups["GPL-3.0"] });
    expect(r.violations).toEqual([{ name: "g", versions: ["2"], license: "GPL-3.0", why: "licence not allowed by policy" }]);
  });
  it("the Nodebox exception holds only while its marker is absent from the bundle", () => {
    expect(evaluate(groups, policy, []).violations.map((v: { name: string }) => v.name)).toEqual(["g"]);
    expect(evaluate(groups, policy, []).excepted.map((e: { name: string }) => e.name)).toEqual(["@codesandbox/nodebox"]);
    const leaked = evaluate(groups, policy, [{ marker: "nodebox-runtime.codesandbox.io", file: "dist/a.js" }]);
    expect(leaked.violations.map((v: { name: string }) => v.name).sort()).toEqual(["@codesandbox/nodebox", "g"]);
    expect(leaked.violations.find((v: { name: string }) => v.name === "@codesandbox/nodebox").why).toMatch(/present in the built bundle/);
  });
  it("an unknown package without an exception fails", () => {
    expect(evaluate({ Unknown: [{ name: "mystery", versions: ["1"] }] }).violations).toHaveLength(1);
  });
});

describe("bundle check", () => {
  it("finds forbidden markers in built files and ignores clean output", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-"));
    try {
      fs.mkdirSync(path.join(d, "assets")); fs.writeFileSync(path.join(d, "assets/ok.js"), "console.log(1)");
      expect(scan(d)).toEqual([]);
      fs.writeFileSync(path.join(d, "assets/bad.js"), 'fetch("https://nodebox-runtime.codesandbox.io/x")');
      expect(scan(d).map((h: { file: string }) => path.basename(h.file))).toEqual(["bad.js"]);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});
