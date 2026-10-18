import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assessRip, classifySpdx, detectLicense, detectLicenseText } from "../src/repo/license";

const text = (f: string) => fs.readFileSync(path.join(__dirname, "fixtures/licenses", f), "utf8");
// Real licence texts (fetched from the projects themselves / the SPDX list). The detector must classify each correctly.
const CASES: [string, string, string][] = [
  ["pixelmatch-isc.txt", "ISC", "permissive"],
  ["apache-2.0.txt", "Apache-2.0", "permissive"],
  ["axe-core-mpl-2.0.txt", "MPL-2.0", "weak-copyleft"],
  ["mpl-2.0.txt", "MPL-2.0", "weak-copyleft"],
  ["gpl-2.0.txt", "GPL-2.0", "strong-copyleft"],
  ["gpl-3.0.txt", "GPL-3.0", "strong-copyleft"],
  ["lgpl-2.1.txt", "LGPL-2.1", "weak-copyleft"],
  ["lgpl-3.0.txt", "LGPL-3.0", "weak-copyleft"],
  ["agpl-3.0.txt", "AGPL-3.0", "network-copyleft"],
  ["convex-fsl-1.1-apache.txt", "FSL-1.1-Apache-2.0", "source-available"],
  ["directus-mscl.txt", "LicenseRef-MSCL", "source-available"],
  ["nodebox-sustainable-use.txt", "LicenseRef-Sustainable-Use", "source-available"],
  ["elastic-2.0.txt", "Elastic-2.0", "source-available"],
  ["busl-1.1.txt", "BUSL-1.1", "source-available"],
  ["sspl-1.0.txt", "SSPL-1.0", "source-available"],
];

describe("detectLicenseText on real licence texts", () => {
  it.each(CASES)("%s → %s (%s)", (file, spdx, cls) => {
    expect(detectLicenseText(text(file))).toEqual({ spdx, class: cls });
  });
  it("is not fooled by line wrapping or extra whitespace", () => {
    const mit = "Permission is hereby granted,\n   free of charge, to any person\nobtaining a copy of this software";
    expect(detectLicenseText(mit)?.spdx).toBe("MIT");
  });
  it("a licence that merely quotes another (FSL names Apache/MIT as its future licence; MPL names the GPL as a secondary licence) is classified by its own title", () => {
    expect(detectLicenseText(text("convex-fsl-1.1-apache.txt"))?.spdx).toBe("FSL-1.1-Apache-2.0");
    expect(detectLicenseText(text("mpl-2.0.txt"))?.spdx).toBe("MPL-2.0");
  });
});

describe("source-available code is never treated as permissive", () => {
  const rip = (file: string, purpose: "clone" | "port" | "mesh" = "port") => assessRip([{ repo: "o/r", licenses: detectLicense([{ path: "LICENSE", content: text(file) }]) }], purpose);
  it("requires the user's attestation before anything is copied", () => {
    for (const f of ["convex-fsl-1.1-apache.txt", "directus-mscl.txt", "nodebox-sustainable-use.txt", "elastic-2.0.txt", "busl-1.1.txt", "sspl-1.0.txt"]) {
      const a = rip(f); expect(a.requiresAttestation, f).toBe(true); expect(a.level, f).toBe("attestation-required");
      expect(a.perRepo[0]!.obligations[0]).toMatch(/source-available/i);
    }
  });
  it("permissive and copyleft texts keep their existing outcomes", () => {
    expect(rip("pixelmatch-isc.txt")).toMatchObject({ level: "attribution", requiresAttestation: false });
    expect(rip("gpl-3.0.txt")).toMatchObject({ level: "copyleft", requiresAttestation: false });
  });
});

describe("manifest licence strings", () => {
  it("source-available SPDX ids are classified as such, not unknown/permissive", () => {
    for (const id of ["FSL-1.1-Apache-2.0", "FSL-1.1-MIT", "Elastic-2.0", "BUSL-1.1", "SSPL-1.0", "CC-BY-NC-4.0"]) expect(classifySpdx(id), id).toBe("source-available");
    expect(classifySpdx("MIT")).toBe("permissive"); expect(classifySpdx("AGPL-3.0-only")).toBe("network-copyleft");
  });
});
