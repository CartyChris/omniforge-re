// PoC (2026-10-18): licence identification test. Usage: node lic_test.mjs <LICENSE files...> (run in a dir with license-similarity spdx-expression-parse spdx-correct installed)
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(process.cwd() + "/");
const { identifyLicense } = require("license-similarity");
const spdxParse = require("spdx-expression-parse");
const spdxCorrect = require("spdx-correct");
const files = process.argv.slice(2);
for (const f of files) {
  const txt = fs.readFileSync(f, "utf8");
  const t0 = Date.now();
  let out;
  try { out = await identifyLicense(txt); } catch (e) { out = "ERR " + e.message; }
  console.log(f.split("/").pop().slice(0, 60), "=>", String(JSON.stringify(out)).slice(0, 300), (Date.now() - t0) + "ms");
}
for (const s of ["MIT", "Apache 2", "apache-2.0", "BSD", "GPL", "(MIT OR Apache-2.0)", "MIT/Apache-2.0", "SEE LICENSE IN LICENSE", "Unlicense", "FSL-1.1-MIT", "BSD 3-Clause", "GPLv3", "LGPL-3.0-or-later AND CC0-1.0"]) {
  let p, c;
  try { p = JSON.stringify(spdxParse(s)); } catch (e) { p = "invalid"; }
  c = spdxCorrect(s);
  console.log("spdx:", JSON.stringify(s), "parse=", p.slice(0, 80), " correct=", c);
}
