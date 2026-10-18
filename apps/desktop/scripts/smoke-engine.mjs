#!/usr/bin/env node
/**
 * Smoke test of a COMPILED engine binary: starts it, serves an obfuscator.io-obfuscated script from a local site, runs a local analysis with
 * deobfuscation on, and fails unless the engine returns a reconstructed readable file, an endpoint only visible after deobfuscation, and a
 * "done" coverage check. Proves the sandboxed webcrack + QuickJS path works inside the Bun-compiled binary on this OS/architecture.
 *   node smoke-engine.mjs <path-to-omniforge-bridge-binary>
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bin = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!bin || !fs.existsSync(bin)) { console.error(`usage: smoke-engine.mjs <engine binary> (not found: ${bin})`); process.exit(2); }
const OBF = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/server/test/fixtures/js/obfuscatorio.js"), "utf8");
const site = http.createServer((q, r) => {
  if (q.url === "/") { r.writeHead(200, { "content-type": "text/html" }); return r.end('<!doctype html><title>o</title><h1>S</h1><script src="/static/app.js"></script>'); }
  if (q.url === "/static/app.js") { r.writeHead(200, { "content-type": "application/javascript" }); return r.end(OBF); }
  r.writeHead(404); r.end();
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${site.address().port}`;
const TOKEN = "smoke-token-0123456789abcdef0123456789", PORT = 4000 + Math.floor(Math.random() * 3000);
const child = spawn(bin, ["--port", String(PORT)], { env: { ...process.env, OMNIFORGE_UI_TOKEN: TOKEN, OMNIFORGE_ALLOWED_ORIGINS: "tauri://localhost" }, cwd: process.env.TMPDIR || "/tmp" });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const fail = (m) => { console.error(`✗ ${m}\n--- engine output\n${log.slice(0, 1500)}`); child.kill(); site.close(); process.exit(1); };
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/bridge/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); } }
if (!up) fail("engine did not become healthy");
const res = await fetch(`http://127.0.0.1:${PORT}/bridge/analyze`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, origin: "tauri://localhost", "content-type": "application/json", "x-omniforge-bridge": "1" }, body: JSON.stringify({ targets: [base + "/"], config: { delayMs: 0, deobfuscate: true } }) });
const done = (await res.text()).split("\n\n").find((b) => b.startsWith("event: done"));
if (!done) fail(`analysis returned no result (HTTP ${res.status})`);
const inv = JSON.parse(done.split("\ndata: ")[1]);
const f = inv.files.find((x) => x.path.startsWith("reconstructed/"));
const check = inv.coverage.checks.find((c) => c.id === "deobfuscation");
const problems = [
  !f && "no reconstructed file", f && f.provenance !== "reconstructed" && `file provenance is ${f.provenance}`,
  f && !f.content.includes("/api/v2/users?limit=50") && "decoded file lacks the hidden string literal",
  !inv.endpoints.some((e) => e.url.endsWith("/api/checkout")) && "endpoint hidden by obfuscation was not found",
  check?.status !== "done" && `coverage check is ${check?.status}: ${check?.detail}`,
].filter(Boolean);
child.kill(); site.close();
if (problems.length) { console.error(`✗ deobfuscation smoke test failed:\n  - ${problems.join("\n  - ")}`); process.exit(1); }
console.log(`✓ ${path.basename(bin)}: deobfuscation works in the compiled engine (${f.path}, ${f.bytes} bytes)`);
