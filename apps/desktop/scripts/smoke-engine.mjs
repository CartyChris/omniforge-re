#!/usr/bin/env node
/**
 * Smoke test of a COMPILED engine binary: starts it, serves an obfuscator.io-obfuscated script from a local site, runs a local analysis with
 * deobfuscation on, and fails unless the engine returns a reconstructed readable file, an endpoint only visible after deobfuscation, and a
 * "done" coverage check. Proves the sandboxed webcrack + QuickJS path works inside the Bun-compiled binary on this OS/architecture.
 * It then analyses a small FastAPI + Spring + Go project folder and fails unless the tree-sitter grammars (read from the app's resource folder)
 * produce the expected HTTP routes — proving both assets and parser work inside the compiled binary.
 *   node smoke-engine.mjs <path-to-omniforge-bridge-binary> [path-to-tree-sitter-resources]
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
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
const grammars = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const child = spawn(bin, ["--port", String(PORT)], { env: { ...process.env, OMNIFORGE_UI_TOKEN: TOKEN, OMNIFORGE_ALLOWED_ORIGINS: "tauri://localhost", ...(grammars ? { OMNIFORGE_GRAMMARS: grammars } : {}) }, cwd: process.env.TMPDIR || "/tmp" });
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

// --- multi-language structure through the compiled engine
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "omni-smoke-"));
fs.writeFileSync(path.join(proj, "main.py"), 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/users/{id}")\ndef get_user(id: int):\n    return 1\n');
fs.writeFileSync(path.join(proj, "Ctl.java"), '@RestController\n@RequestMapping("/api")\nclass Ctl {\n  @GetMapping("/ping") String ping() { return ""; }\n}\n');
fs.writeFileSync(path.join(proj, "srv.go"), 'package main\nfunc main() { r.GET("/health", h) }\n');
const H = { authorization: `Bearer ${TOKEN}`, origin: "tauri://localhost", "content-type": "application/json", "x-omniforge-bridge": "1" };
const rootRes = await fetch(`http://127.0.0.1:${PORT}/bridge/roots`, { method: "POST", headers: H, body: JSON.stringify({ path: proj }) });
const root = await rootRes.json();
const folderRes = await fetch(`http://127.0.0.1:${PORT}/bridge/analyze-folder`, { method: "POST", headers: H, body: JSON.stringify({ root: root.id }) });
const folder = folderRes.ok ? await folderRes.json() : null;
const got = (folder?.endpoints ?? []).map((e) => `${e.method} ${e.url}`).sort();
const want = ["GET /api/ping", "GET /health", "GET /users/{id}"];
if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`tree-sitter routes: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}; structure check: ${JSON.stringify(folder?.coverage?.checks?.find((c) => c.id === "structure"))}`);
fs.rmSync(proj, { recursive: true, force: true });
// --- OmniForge as an MCP server (`<binary> mcp`): handshake, tool list, and a real analysis through the compiled binary
{
  const m = spawn(bin, ["mcp", "--allow-private"], { stdio: ["pipe", "pipe", "pipe"] }); const lines = []; let acc = "";
  m.stdout.on("data", (d) => { acc += d; let i; while ((i = acc.indexOf("\n")) >= 0) { lines.push(acc.slice(0, i)); acc = acc.slice(i + 1); } });
  const send = (o) => m.stdin.write(JSON.stringify(o) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "analyze_url", arguments: { url: `${base}/`, max_pages: 2 } } });
  for (let i = 0; i < 300 && lines.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
  m.stdin.end(); m.kill();
  try {
    const by = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((r) => [r.id, r]));
    const names = (by[2]?.result?.tools ?? []).map((t) => t.name).join(",");
    if (by[1]?.result?.serverInfo?.name !== "omniforge-re") problems.push("mcp: no initialize result");
    if (names !== "analyze_url,list_investigations,get_investigation,rebuild_plan") problems.push(`mcp: tools are ${names}`);
    if (!/Investigation \S+ \(\d+ pages/.test(by[3]?.result?.content?.[0]?.text ?? "")) problems.push(`mcp: analyze_url returned ${JSON.stringify(by[3]).slice(0, 300)}`);
  } catch (e) { problems.push(`mcp: stdout was not clean JSON-RPC (${e.message}); got ${lines.slice(0, 3).join(" | ").slice(0, 300)}`); }
}
child.kill(); site.close();
if (problems.length) { console.error(`✗ deobfuscation smoke test failed:\n  - ${problems.join("\n  - ")}`); process.exit(1); }
console.log(`✓ ${path.basename(bin)}: deobfuscation, tree-sitter route extraction and the MCP server work in the compiled engine (${f.path}, ${f.bytes} bytes; routes ${want.join(", ")})`);
