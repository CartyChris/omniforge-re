import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM fixture
import { createFixture } from "../../../fixtures/server.mjs";
import { startBridge, type Bridge } from "../src/bridge/server";
import { findChrome } from "../src/bridge/render";

let bridge: Bridge; let tmp: string; let fx: ReturnType<typeof createFixture>; let fxBase: string;
const WEB = "https://omniforge.example";
const SAMPLE = path.resolve(__dirname, "../../../fixtures/electron-sample");

/** Raw HTTP client so we control Host/Origin exactly (fetch forbids some headers). */
function call(method: string, p: string, o: { token?: string; origin?: string; body?: unknown; host?: string; csrf?: boolean; raw?: boolean } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${bridge.port}` };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.origin) headers.origin = o.origin;
    if (o.csrf !== false && method !== "GET" && method !== "OPTIONS") headers["x-omniforge-bridge"] = "1";
    const body = o.body === undefined ? undefined : JSON.stringify(o.body);
    if (body) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(body)); }
    const req = http.request({ host: "127.0.0.1", port: bridge.port, method, path: p, headers }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j: any; try { j = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode!, headers: res.headers, text: t, json: j }); }); });
    req.on("error", reject); if (body) req.write(body); req.end();
  });
}
const ui = (method: string, p: string, body?: unknown) => call(method, p, { token: bridge.auth.uiToken, origin: "tauri://localhost", body });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-e2e-"));
  process.env.OMNIFORGE_HOME = path.join(tmp, "home"); process.env.REA_BIN = path.resolve(__dirname, "../node_modules/.bin/rea");
  bridge = await startBridge({ jobsDir: path.join(tmp, "jobs"), reaDir: path.join(tmp, "rea"), agentCliPath: path.join(__dirname, "fixtures/fake-claude.mjs") });
  fx = createFixture(); fxBase = await fx.listen();
}, 30_000);
afterAll(async () => { await bridge.close(); await fx.close(); fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.OMNIFORGE_HOME; delete process.env.REA_BIN; });

describe("transport security", () => {
  it("binds to loopback only and answers health to anyone (no secrets)", async () => {
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await call("GET", "/bridge/health", { origin: "https://anything.example" });
    expect(r.json).toMatchObject({ ok: true, name: "omniforge-bridge", pairingRequired: true });
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(JSON.stringify(r.json)).not.toMatch(/token|path|\/home|\/root/i);
  });
  it("rejects wrong Host headers (DNS rebinding) and missing CSRF header", async () => {
    expect((await call("GET", "/bridge/health", { host: "evil.example" })).status).toBe(403);
    expect((await call("GET", "/bridge/health", { host: `attacker.test:${bridge.port}` })).status).toBe(403);
    expect((await call("POST", "/bridge/pair", { body: { code: "X" }, origin: WEB, csrf: false })).status).toBe(403);
  });
  it("is unauthenticated by default: protected routes need a token", async () => {
    for (const p of ["/bridge/info", "/bridge/roots", "/bridge/cli", "/bridge/jobs", "/bridge/rea/status"]) expect((await call("GET", p)).status, p).toBe(401);
    expect((await call("GET", "/bridge/info", { token: "wrong-token" })).status).toBe(401);
    expect((await call("GET", "/bridge/nope", { token: bridge.auth.uiToken, origin: "tauri://localhost" })).status).toBe(404);
  });
  it("CORS: preflight approved only for the app and bound origins", async () => {
    expect((await call("OPTIONS", "/bridge/info", { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("OPTIONS", "/bridge/info", { origin: "tauri://localhost" })).headers["access-control-allow-origin"]).toBe("tauri://localhost");
  });
});

describe("pairing → approval → scoped access", () => {
  let token: string; let sessionId: string; let rootId: string; let proj: string;
  beforeAll(() => { proj = path.join(tmp, "proj"); fs.mkdirSync(path.join(proj, "src"), { recursive: true }); fs.writeFileSync(path.join(proj, "src/a.ts"), "export const a = 1;\n"); fs.writeFileSync(path.join(proj, ".env"), "SECRET_KEY=hunter2-value\n"); fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "p", dependencies: { react: "19" } })); });

  it("the web app cannot mint its own pairing code; the desktop UI can", async () => {
    expect((await call("POST", "/bridge/ui/pairing-code", { origin: WEB })).status).toBe(401);
    const r = await ui("POST", "/bridge/ui/pairing-code");
    expect(r.status).toBe(200);
    const paired = await call("POST", "/bridge/pair", { origin: WEB, body: { code: r.json.code } });
    expect(paired.status).toBe(200);
    expect(paired.json.scopes.sort()).toEqual(["analyze", "detect", "models"]);
    token = paired.json.token; sessionId = paired.json.sessionId;
    expect((await call("POST", "/bridge/pair", { origin: WEB, body: { code: r.json.code } })).status).toBe(401); // single use
    expect((await call("OPTIONS", "/bridge/info", { origin: WEB })).headers["access-control-allow-origin"]).toBe(WEB); // now bound
  });
  it("a paired session gets detection but NOT files, jobs or CLIs until the desktop app grants them", async () => {
    const info = await call("GET", "/bridge/info", { token, origin: WEB });
    expect(info.status).toBe(200);
    expect(info.json).toMatchObject({ version: "0.1.0", system: { platform: process.platform } });
    expect(info.json.tools.some((t: any) => t.id === "node" && t.status === "available")).toBe(true);
    expect(info.json.roots).toEqual([]);
    for (const [m, p, b] of [["GET", "/bridge/roots"], ["POST", "/bridge/jobs", { root: "x", cmd: "ls" }], ["GET", "/bridge/cli"], ["GET", "/bridge/rea/status"], ["POST", "/bridge/git/status", { root: "x" }]] as const)
      expect((await call(m, p, { token, origin: WEB, body: b })).status, p).toBe(403);
    expect((await call("GET", "/bridge/info", { token, origin: "https://evil.example" })).status).toBe(403); // stolen token, wrong site
    expect((await call("POST", "/bridge/roots", { token, origin: WEB, body: { path: proj } })).status).toBe(403); // cannot approve its own folder
  });
  it("the user approves a folder and a scope; only then can the session read — and .env values stay hidden", async () => {
    const add = await ui("POST", "/bridge/roots", { path: proj, writable: false });
    expect(add.status).toBe(200); rootId = add.json.id;
    expect((await ui("POST", `/bridge/sessions/${sessionId}/scope`, { scope: "fs:read" })).json.ok).toBe(true);
    const roots = await call("GET", "/bridge/roots", { token, origin: WEB });
    expect(roots.json).toEqual([{ id: rootId, label: "proj", writable: false }]); // no absolute path leaked to the web
    const tree = await call("GET", `/bridge/fs/tree?root=${rootId}`, { token, origin: WEB });
    expect(tree.json.entries.map((e: any) => e.path)).toEqual([".env", "package.json", "src", "src/a.ts"]);
    expect((await call("GET", `/bridge/fs/read?root=${rootId}&path=src/a.ts`, { token, origin: WEB })).json.content).toBe("export const a = 1;\n");
    const env = await call("GET", `/bridge/fs/read?root=${rootId}&path=.env`, { token, origin: WEB });
    expect(env.json.masked).toBe(true);
    expect(env.text).not.toContain("hunter2-value");
    expect((await call("GET", `/bridge/fs/read?root=${rootId}&path=../../etc/passwd`, { token, origin: WEB })).status).toBe(403);
    expect((await call("POST", "/bridge/fs/write", { token, origin: WEB, body: { root: rootId, path: "x.txt", content: "no" } })).status).toBe(403); // needs fs:write
  });
  it("analyzes the approved folder into a full Investigation", async () => {
    const r = await call("POST", "/bridge/analyze-folder", { token, origin: WEB, body: { root: rootId } });
    expect(r.status).toBe(200);
    expect(r.json.technologies.map((t: any) => t.name)).toContain("React");
    expect(JSON.stringify(r.json)).not.toContain("hunter2-value");
    expect(r.json.envVars.map((e: any) => e.name)).toContain("SECRET_KEY");
  });
  it("revoking the session ends access immediately", async () => {
    expect((await ui("DELETE", `/bridge/sessions/${sessionId}`)).status).toBe(200);
    expect((await call("GET", "/bridge/info", { token, origin: WEB })).status).toBe(401);
  });
});

describe("privileged capabilities through the bridge (desktop UI token)", () => {
  let rootId: string;
  beforeAll(async () => { rootId = (await ui("POST", "/bridge/roots", { path: path.resolve(__dirname, "../../../fixtures"), writable: false })).json.id; });

  it("deletes only regular files inside a writable approved folder (never folders, links, secrets, or paths outside)", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "d-")); const outside = fs.mkdtempSync(path.join(tmp, "out-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "x"); fs.writeFileSync(path.join(dir, ".env"), "K=1"); fs.mkdirSync(path.join(dir, "sub")); fs.writeFileSync(path.join(outside, "victim.txt"), "keep"); fs.symlinkSync(path.join(outside, "victim.txt"), path.join(dir, "link.txt"));
    const roDir = fs.mkdtempSync(path.join(tmp, "ro-")); fs.writeFileSync(path.join(roDir, "a.txt"), "x");
    const w = (await ui("POST", "/bridge/roots", { path: dir, writable: true })).json.id; const ro = (await ui("POST", "/bridge/roots", { path: roDir, writable: false })).json.id;
    expect((await ui("POST", "/bridge/fs/delete", { root: ro, path: "a.txt" })).status).toBe(403); // read-only approval
    expect(fs.existsSync(path.join(roDir, "a.txt"))).toBe(true);
    expect((await ui("POST", "/bridge/fs/delete", { root: w, path: "../" + path.basename(outside) + "/victim.txt" })).status).toBe(403); // traversal
    expect((await ui("POST", "/bridge/fs/delete", { root: w, path: ".env" })).status).toBe(403); // credential-style file
    expect((await ui("POST", "/bridge/fs/delete", { root: w, path: "sub" })).status).toBe(400); // folders refused
    expect((await ui("POST", "/bridge/fs/delete", { root: w, path: "link.txt" })).status).toBeGreaterThanOrEqual(400); // symlink escaping the root
    expect(fs.existsSync(path.join(outside, "victim.txt"))).toBe(true);
    const ok = await ui("POST", "/bridge/fs/delete", { root: w, path: "a.txt" });
    expect(ok.status).toBe(200); expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(false);
    expect((await ui("POST", "/bridge/fs/delete", { root: w, path: "a.txt" })).status).toBeGreaterThanOrEqual(400); // already gone
  });
  it("streams job output over SSE and cancels a running job (process group)", async () => {
    const wr = (await ui("POST", "/bridge/roots", { path: fs.mkdtempSync(path.join(tmp, "w-")), writable: true })).json.id;
    const job = (await ui("POST", "/bridge/jobs", { root: wr, cmd: "node", args: ["-e", "console.log('line1');setTimeout(()=>console.log('line2'),150);setTimeout(()=>{},30000)"] })).json;
    const lines: string[] = [];
    const reqP = new Promise<void>((resolve) => {
      const rq = http.request({ host: "127.0.0.1", port: bridge.port, path: `/bridge/jobs/${job.id}/stream`, headers: { host: `127.0.0.1:${bridge.port}`, authorization: `Bearer ${bridge.auth.uiToken}`, origin: "tauri://localhost" } }, (res) => { res.on("data", (c) => { for (const m of String(c).matchAll(/event: line\ndata: (.+)/g)) lines.push(JSON.parse(m[1]!).text); if (String(c).includes("event: end")) resolve(); }); });
      rq.end(); setTimeout(async () => { await ui("POST", `/bridge/jobs/${job.id}/cancel`); }, 700);
    });
    await reqP;
    expect(lines).toEqual(expect.arrayContaining(["line1", "line2"]));
    expect((await ui("GET", "/bridge/jobs")).json.find((j: any) => j.id === job.id).state).toBe("cancelled");
  }, 20_000);

  it("runs REA through the bridge and returns the real evidence as an Investigation", async () => {
    const job = (await ui("POST", "/bridge/rea/jobs", { op: "analyze-javascript-application", root: rootId, path: "electron-sample" })).json;
    expect(job.id).toBeTruthy();
    for (let i = 0; i < 400; i++) { const j = (await ui("GET", "/bridge/jobs")).json.find((x: any) => x.id === job.id); if (j.state !== "running") break; await sleep(100); }
    await sleep(300);
    const sum = await ui("GET", `/bridge/rea/jobs/${job.id}/result?view=summary`);
    expect(sum.json).toMatchObject({ authority: "shipped-artifact", provider: { id: expect.any(String) } });
    const inv = (await ui("GET", `/bridge/rea/jobs/${job.id}/result?view=investigation`)).json;
    expect(inv.features.map((f: any) => f.name)).toContain("Electron IPC bridge");
    const native = await ui("POST", "/bridge/rea/jobs", { op: "analyze", root: rootId, path: "electron-sample" });
    expect(native.status).toBe(400); // native analysis launches Hopper/Ghidra/IDA: refused without explicit approval
    expect(native.json.error).toMatch(/explicit approval/);
  }, 60_000);

  it("rejects REA paths outside approved roots and non-allow-listed operations", async () => {
    expect((await ui("POST", "/bridge/rea/jobs", { op: "analyze-javascript-application", root: rootId, path: "../../../../etc" })).status).toBe(403);
    const frida = await ui("POST", "/bridge/rea/jobs", { op: "instrument-with-frida", root: rootId, path: "." });
    expect(frida.status).toBe(400);
    expect(frida.json.error).toMatch(/not an allowed REA operation/);
  });

  it("runs a full local website analysis over the bridge (SSE), same engine as hosted", async () => {
    const r = await call("POST", "/bridge/analyze", { token: bridge.auth.uiToken, origin: "tauri://localhost", body: { targets: [fxBase + "/"], config: { delayMs: 0 } } });
    expect(r.status).toBe(200);
    const done = r.text.split("\n\n").find((b) => b.startsWith("event: done"))!;
    const inv = JSON.parse(done.split("\ndata: ")[1]!);
    expect(inv.pages.length).toBe(12);
    expect(inv.files.map((f: any) => f.path).sort()).toEqual(["src/App.tsx", "src/api.ts"]);
  }, 60_000);

  it("verifies a rebuild against a reference over the bridge: auth + input validation always; a real comparison when Chrome exists", async () => {
    expect((await call("POST", "/bridge/verify", { origin: WEB, body: { reference: fxBase + "/", rebuilt: fxBase + "/" } })).status).toBe(401);
    for (const bad of [{ reference: "file:///etc/passwd", rebuilt: fxBase + "/" }, { reference: fxBase + "/", rebuilt: "not a url" }, {}]) {
      const r = await ui("POST", "/bridge/verify", bad); expect(r.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500);
    }
    if (!findChrome()) return;
    const same = await ui("POST", "/bridge/verify", { reference: fxBase + "/", rebuilt: fxBase + "/" });
    expect(same.status).toBe(200);
    expect(same.json.report.summary).toMatchObject({ status: "match", worstVisualRatio: 0 });
    expect(Object.keys(same.json.images)).toEqual(["desktop", "mobile"]);
    expect(same.json.images.desktop.diff).toMatch(/^data:image\/png;base64,/);
    const other = await ui("POST", "/bridge/verify", { reference: fxBase + "/", rebuilt: fxBase + "/about" });
    expect(other.json.report.summary.status).not.toBe("match");
    expect(other.json.report.discrepancies.length).toBeGreaterThan(0);
  }, 120_000);

  it("deobfuscates an obfuscator.io script during a local analysis: readable reconstructed file, an endpoint only visible afterwards, honest coverage", async () => {
    const OBF = fs.readFileSync(path.join(__dirname, "fixtures/js/obfuscatorio.js"), "utf8");
    const srv = http.createServer((q, r) => {
      if (q.url === "/") { r.writeHead(200, { "content-type": "text/html" }); return r.end('<!doctype html><title>obf</title><h1>Shop</h1><script src="/static/app.js"></script>'); }
      if (q.url === "/static/app.js") { r.writeHead(200, { "content-type": "application/javascript" }); return r.end(OBF); }
      r.writeHead(404); r.end();
    });
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const run = async (deobfuscate: boolean) => {
        const r = await call("POST", "/bridge/analyze", { token: bridge.auth.uiToken, origin: "tauri://localhost", body: { targets: [base + "/"], config: { delayMs: 0, deobfuscate } } });
        expect(r.status).toBe(200);
        return JSON.parse(r.text.split("\n\n").find((b) => b.startsWith("event: done"))!.split("\ndata: ")[1]!);
      };
      const off = await run(false);
      expect(off.endpoints.some((e: any) => e.url.includes("/api/checkout"))).toBe(false); // hidden in the string array
      expect(off.files).toEqual([]);
      const on = await run(true);
      expect(on.endpoints.some((e: any) => e.url === base + "/api/checkout" && /deobfuscated/.test(e.foundIn))).toBe(true);
      const f = on.files.find((x: any) => x.path.startsWith("reconstructed/"));
      expect(f).toMatchObject({ provenance: "reconstructed", language: "JavaScript" });
      expect(f.content).toContain("/api/v2/users?limit=50");
      expect(on.files.some((x: any) => x.provenance === "recovered")).toBe(false);
      expect(on.coverage.checks.find((c: any) => c.id === "deobfuscation")).toMatchObject({ status: "done" });
    } finally { srv.close(); }
  }, 120_000);

  it("agent mode over the bridge: the CLI edits an isolated copy; changes are reviewed, then applied with a backup; conflicts and read-only folders are respected", async () => {
    const proj = path.join(tmp, "agent-proj"); fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    fs.writeFileSync(path.join(proj, "src/app.js"), "console.log(1);\n"); fs.writeFileSync(path.join(proj, "old.txt"), "old\n"); fs.writeFileSync(path.join(proj, ".env"), "SECRET=1\n");
    const ro = (await ui("POST", "/bridge/roots", { path: proj, writable: false })).json;
    // a web session without the cli/fs scopes cannot start a run
    expect((await call("POST", "/bridge/agent/run", { origin: WEB, body: { cli: "claude-code", root: ro.id, prompt: "x" } })).status).toBe(401);
    const bad = await ui("POST", "/bridge/agent/run", { cli: "gemini", root: ro.id, prompt: "x" }); expect(bad.status).toBe(400);
    const empty = await ui("POST", "/bridge/agent/run", { cli: "claude-code", root: ro.id, prompt: "   " }); expect(empty.status).toBeGreaterThanOrEqual(400);
    // MCP servers are validated by the engine itself, whatever the UI sent: nothing starts and nothing is copied
    for (const mcpServers of [[{ name: "x", command: "bash", args: ["-c", "id"] }], [{ name: "Bad_Name", command: "npx" }], [{ name: "u", url: "http://example.com/mcp" }], [{ name: "d", command: "npx" }, { name: "d", command: "npx" }]]) {
      const r = await ui("POST", "/bridge/agent/run", { cli: "claude-code", root: ro.id, prompt: "x", mcpServers }); expect(r.status, JSON.stringify(mcpServers)).toBe(400);
      expect(JSON.stringify(r.json)).toMatch(/MCP server|unique/);
    }

    // run (the scripted CLI, default 'edit' behaviour): SSE start → events → done with the change list
    const r = await call("POST", "/bridge/agent/run", { token: bridge.auth.uiToken, origin: "tauri://localhost", body: { cli: "claude-code", root: ro.id, prompt: "Add a header comment" } });
    expect(r.status).toBe(200);
    const blocks = r.text.split("\n\n").filter(Boolean).map((b) => ({ ev: b.match(/^event: (.+)$/m)?.[1], data: JSON.parse(b.match(/^data: (.+)$/m)?.[1] ?? "null") }));
    const start = blocks.find((b) => b.ev === "start")!.data; const done = blocks.find((b) => b.ev === "done")!.data;
    expect(start.skipped.some((k: any) => k.path === ".env")).toBe(true); expect(start.copied).toBe(2);
    expect(done.ok).toBe(true); expect(done.changes.map((c: any) => `${c.status}:${c.path}`)).toEqual(["added:logo.bin", "deleted:old.txt", "modified:src/app.js", "added:src/new.js"]);
    expect(fs.readFileSync(path.join(proj, "src/app.js"), "utf8")).toBe("console.log(1);\n"); // untouched until apply
    const id = start.runId;

    // review
    const file = await ui("GET", `/bridge/agent/runs/${id}/file?path=${encodeURIComponent("src/app.js")}`); expect(file.json.base).toBe("console.log(1);\n"); expect(file.json.next).toContain("edited by agent");
    expect((await ui("GET", `/bridge/agent/runs/${id}/changes`)).json.changes).toHaveLength(4);

    // a read-only folder cannot be applied to
    expect((await ui("POST", `/bridge/agent/runs/${id}/apply`, { paths: ["src/app.js"] })).status).toBe(403);
    const rw = (await ui("POST", "/bridge/roots", { path: proj, writable: true })).json; expect(rw.id).toBe(ro.id); // same folder, now writable
    const ok = await ui("POST", `/bridge/agent/runs/${id}/apply`, { paths: ["src/app.js", "src/new.js", "old.txt"] });
    expect(ok.status).toBe(200); expect(ok.json.applied.sort()).toEqual(["src/app.js", "src/new.js"]); expect(ok.json.refused).toEqual([{ path: "old.txt", reason: "deletions were not enabled" }]);
    expect(fs.readFileSync(path.join(proj, "src/app.js"), "utf8")).toContain("edited by agent"); expect(fs.existsSync(path.join(proj, "old.txt"))).toBe(true);
    expect(ok.json.backup).toBeTruthy(); // the overwritten file was backed up so it can be restored
    expect((await ui("GET", "/bridge/changes")).json.changes.some((c: any) => c.action === "agent-apply" && c.files.includes("src/app.js"))).toBe(true);

    // discarding removes the copy
    expect((await ui("DELETE", `/bridge/agent/runs/${id}`)).json).toEqual({ ok: true });
    expect((await ui("GET", `/bridge/agent/runs/${id}/changes`)).status).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it("detects the REAL Claude Code CLI and lists it as usable (skipped if not installed)", async () => {
    const r = await ui("GET", "/bridge/cli");
    const claude = r.json.find((c: any) => c.id === "claude-code");
    expect(claude).toBeTruthy();
    if (claude.status === "not-installed") return;
    expect(claude).toMatchObject({ method: "print-stream-json" });
    expect((await ui("GET", "/bridge/models")).json.clis.map((c: any) => c.id)).toEqual(expect.arrayContaining(claude.status === "ready" ? ["claude-code"] : []));
  }, 60_000);

  it("forwards to local model servers only (loopback + known ports), so a hosted page never calls localhost itself", async () => {
    const mock = http.createServer((q, r) => { const ch: Buffer[] = []; q.on("data", (c) => ch.push(c)); q.on("end", () => { const raw = Buffer.concat(ch); r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ echoed: raw.toString(), hex: raw.toString("hex"), auth: q.headers.authorization ?? null })); }); }).listen(0, "127.0.0.1");
    await new Promise((r) => mock.once("listening", r));
    const port = (mock.address() as any).port;
    try {
      process.env.OMNIFORGE_LOCAL_PORTS = String(port);
      const ok = await ui("POST", "/bridge/forward", { url: `http://127.0.0.1:${port}/api/chat`, method: "POST", headers: { "content-type": "application/json", authorization: "Bearer k", cookie: "drop-me" }, body: '{"hi":1}' });
      expect(ok.json).toMatchObject({ echoed: '{"hi":1}', auth: "Bearer k" });
      // bytes (e.g. a Netlify ZIP) travel as bodyBase64 and arrive byte-for-byte
      const bin = await ui("POST", "/bridge/forward", { url: `http://127.0.0.1:${port}/zip`, method: "POST", headers: { "content-type": "application/zip" }, bodyBase64: Buffer.from([0x50, 0x4b, 0, 255, 13, 10]).toString("base64") });
      expect(bin.json.hex).toBe("504b00ff0d0a");
      expect((await ui("POST", "/bridge/forward", { url: `http://127.0.0.1:${port}/zip`, method: "POST", bodyBase64: "%%%" })).status).toBe(400);
      for (const url of ["http://127.0.0.1:22/", "http://localhost:3306/", "http://169.254.169.254/", "https://evil.example/x", "http://10.0.0.5:11434/", "https://localhost:11434/", "http://127.0.0.1:11434/../etc"]) expect((await ui("POST", "/bridge/forward", { url })).status, url).toBeGreaterThanOrEqual(400);
      expect((await ui("POST", "/bridge/forward", { url: "https://api.openai.com/v1/models" })).status).not.toBe(403); // allow-listed API host is permitted (may 401/502 offline)
      expect((await call("POST", "/bridge/forward", { origin: WEB, body: { url: `http://127.0.0.1:${port}/` } })).status).toBe(401);
    } finally { mock.close(); delete process.env.OMNIFORGE_LOCAL_PORTS; }
  });

  it("only the desktop UI can read the change log or restore backups", async () => {
    expect((await call("GET", "/bridge/changes")).status).toBe(401);
    expect((await ui("GET", "/bridge/changes")).json).toHaveProperty("backups");
  });
});
