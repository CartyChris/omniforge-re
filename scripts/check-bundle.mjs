#!/usr/bin/env node
/**
 * Fails when a built bundle contains markers of code we are not licensed to ship.
 * Usage: node scripts/check-bundle.mjs [dir ...]   (default: apps/web/dist)
 */
import fs from "node:fs";
import path from "node:path";

export const FORBIDDEN = [
  { marker: "nodebox-runtime.codesandbox.io", why: "@codesandbox/nodebox (Sustainable Use License: internal-business / non-commercial use only)" },
  { marker: "Sustainable Use License", why: "Sustainable Use License text bundled" },
];

export function scan(dir) {
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js|css|html|json|map)$/.test(e.name)) { const t = fs.readFileSync(p, "utf8"); for (const f of FORBIDDEN) if (t.includes(f.marker)) hits.push({ file: p, ...f }); } } };
  if (fs.existsSync(dir)) walk(dir);
  return hits;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ["apps/web/dist"];
  const missing = dirs.filter((d) => !fs.existsSync(d));
  if (missing.length) { console.error(`bundle check: ${missing.join(", ")} does not exist — build first`); process.exit(2); }
  const hits = dirs.flatMap(scan);
  for (const h of hits) console.error(`✗ ${h.file}: contains "${h.marker}" — ${h.why}`);
  if (hits.length) process.exit(1);
  console.log(`bundle check: ${dirs.join(", ")} clean`);
}
