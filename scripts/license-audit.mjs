#!/usr/bin/env node
/**
 * Dependency licence gate. Reads `pnpm licenses list --prod --json` and fails on any production dependency whose licence is not allowed by
 * scripts/license-policy.json (unknown, unparsable, copyleft, source-available, non-commercial). Exceptions need a reason; when the risk is
 * shipping the code they also name a marker that must not appear in the built bundle (checked here when a bundle exists).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import parse from "spdx-expression-parse";
import { scan } from "./check-bundle.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const policy = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/license-policy.json"), "utf8"));

/** true if the SPDX expression is acceptable under `allowed`. */
export function acceptable(expr, allowed) {
  let ast; try { ast = parse(expr); } catch { return false; }
  const ok = (n) => (n.license ? allowed.includes(n.license) : n.conjunction === "or" ? ok(n.left) || ok(n.right) : ok(n.left) && ok(n.right));
  return ok(ast);
}

/** Pure: groups = output of `pnpm licenses list --json`. Returns violations (and exceptions that applied). */
export function evaluate(groups, pol = policy, bundleHits = []) {
  const violations = [], excepted = [];
  for (const [lic, pkgs] of Object.entries(groups)) for (const p of pkgs) {
    if (acceptable(lic, pol.allowed)) continue;
    const ex = pol.exceptions.find((e) => e.name === p.name);
    if (!ex) { violations.push({ name: p.name, versions: p.versions, license: lic, why: "licence not allowed by policy" }); continue; }
    const leaked = ex.bundleMarker ? bundleHits.filter((h) => h.marker === ex.bundleMarker) : [];
    if (leaked.length) violations.push({ name: p.name, versions: p.versions, license: lic, why: `excepted, but "${ex.bundleMarker}" is present in the built bundle (${leaked[0].file})` });
    else excepted.push({ name: p.name, license: lic, reason: ex.reason });
  }
  return { violations, excepted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64e6 });
  const groups = JSON.parse(out);
  const dirs = ["apps/web/dist"].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
  const hits = dirs.flatMap(scan);
  if (!dirs.length) console.warn("note: no built bundle found — exceptions that rely on bundle exclusion are not verified (run after `pnpm build`)");
  const { violations, excepted } = evaluate(groups, policy, hits);
  for (const e of excepted) console.log(`~ ${e.name} (${e.license}): excepted — ${e.reason}`);
  for (const v of violations) console.error(`✗ ${v.name}@${v.versions?.join(",")} — ${v.license}: ${v.why}`);
  const n = Object.values(groups).reduce((a, g) => a + g.length, 0);
  if (violations.length) { console.error(`licence audit failed: ${violations.length} of ${n} production packages`); process.exit(1); }
  console.log(`licence audit passed: ${n} production packages (${excepted.length} excepted)`);
}
