import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deobfuscateScripts, looksObfuscated, type DeobfuscateOutput, type Deobfuscator } from "../src/analyze/deobfuscate";
import { investigate } from "../src/crawl/investigate";

const hexy = (n = 30) => Array.from({ length: n }, (_, i) => `var _0x${(0x1000 + i).toString(16)}=${i};`).join("") + "x".repeat(2000);
const webpack = "(()=>{var __webpack_modules__={1:(e,t,r)=>{r(2)}};function __webpack_require__(e){}})();" + " ".repeat(2000);
const minified = "a".repeat(1700) + "\n" + "b".repeat(1700);
const readable = "function add(a, b) {\n  return a + b;\n}\n".repeat(120);

describe("looksObfuscated", () => {
  it("flags obfuscator-style names, bundles and unreadable minification — not readable or tiny code", () => {
    expect(looksObfuscated(hexy())).toMatchObject({ yes: true, why: expect.stringMatching(/hex-named/) });
    expect(looksObfuscated(webpack)).toMatchObject({ yes: true, why: "module bundle" });
    expect(looksObfuscated(minified)).toMatchObject({ yes: true, why: expect.stringMatching(/minified/) });
    expect(looksObfuscated(readable).yes).toBe(false);
    expect(looksObfuscated("var _0x1234=1;").yes).toBe(false);
  });
});

const ok = (code: string, extra: Partial<DeobfuscateOutput> = {}): DeobfuscateOutput => ({ ok: true, tool: "fake", code, unpacked: false, changed: true, notes: [], ...extra });
const first = (u: string) => u.startsWith("https://site.test/");

describe("deobfuscateScripts", () => {
  it("makes first-party candidates readable as RECONSTRUCTED files; leaves third-party and readable scripts alone", async () => {
    const calls: string[] = [];
    const d: Deobfuscator = { deobfuscate: async (c) => { calls.push(c.slice(0, 8)); return ok("const url = '/api/v2/users';"); } };
    const r = await deobfuscateScripts(new Map([["https://site.test/static/app.js", hexy()], ["https://cdn.other.com/lib.js", hexy(40)], ["https://site.test/readable.js", readable]]), d, { firstParty: first });
    expect(r.stats).toMatchObject({ candidates: 2, attempted: 1, ok: 1, skipped: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ path: "reconstructed/site.test/app.js", provenance: "reconstructed", language: "JavaScript" });
    expect(r.files[0]!.origin).toContain("fake: hex-named identifiers");
  });
  it("never labels output as recovered, and an engine failure is counted, not thrown", async () => {
    const d: Deobfuscator = { deobfuscate: async () => { throw new Error("sandbox crashed"); } };
    const r = await deobfuscateScripts(new Map([["https://site.test/a.js", hexy()]]), d, { firstParty: first });
    expect(r.stats).toMatchObject({ attempted: 1, ok: 0, failed: 1 }); expect(r.files).toEqual([]);
    expect(r.results[0]!.out.error).toBe("sandbox crashed");
  });
  it("splits bundles into modules with safe paths (no traversal) and redacts secrets before storing", async () => {
    const key = "AKIA" + "ABCDEFGHIJKLMNOP";
    const d: Deobfuscator = { deobfuscate: async () => ok("", { code: undefined, unpacked: true, modules: [{ path: "../../etc/passwd.js", code: "export const a = 1;" }, { path: "/src/api.js", code: `const k = "${key}";` }] }) };
    const r = await deobfuscateScripts(new Map([["https://site.test/main.js", webpack]]), d, { firstParty: first });
    expect(r.stats.unpacked).toBe(1);
    expect(r.files.map((f) => f.path)).toEqual(["reconstructed/site.test/main/etc/passwd.js", "reconstructed/site.test/main/src/api.js"]); // ".." and leading "/" cannot escape the folder
    for (const f of r.files) expect(f.path).not.toMatch(/(^|\/)\.\.?(\/|$)/);
    const api = r.files.find((f) => f.path.endsWith("src/api.js"))!;
    expect(api.content).not.toContain(key); expect(api.content).toContain("[REDACTED:aws-access-key]"); expect(api.redacted).toContain("aws-access-key");
  });
  it("caps the number of scripts per run and stops when aborted", async () => {
    const m = new Map(Array.from({ length: 12 }, (_, i) => [`https://site.test/${i}.js`, hexy(30 + i)] as const));
    const d: Deobfuscator = { deobfuscate: async () => ok("x") };
    expect((await deobfuscateScripts(m, d, { firstParty: first })).stats).toMatchObject({ candidates: 12, attempted: 8, skipped: 4 });
    const ctl = new AbortController(); ctl.abort();
    expect((await deobfuscateScripts(m, d, { firstParty: first, signal: ctl.signal })).stats.attempted).toBe(0);
  });
});

describe("investigate() with a deobfuscator", () => {
  let srv: http.Server, base: string;
  const OBF = hexy(40);
  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<!doctype html><title>t</title><h1>hi</h1><script src="/app.js"></script>'); }
      if (req.url === "/app.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end(OBF); }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));
  const run = (o: Parameters<typeof investigate>[0]["config"], d?: Deobfuscator) => investigate({ targets: [base + "/"], allowPrivate: true, config: { delayMs: 0, ...o }, deobfuscator: d });

  it("finds an endpoint that only exists in the deobfuscated code, labelled reconstructed, with a coverage check", async () => {
    const d: Deobfuscator = { deobfuscate: async () => ok("fetch('/api/v2/users?limit=50');") };
    const inv = await run({ deobfuscate: true }, d);
    expect(inv.status).toBe("done");
    expect(inv.endpoints.map((e) => e.url)).toContain(base + "/api/v2/users?limit=50");
    expect(inv.endpoints.find((e) => e.url.includes("/api/v2/users"))!.foundIn).toMatch(/deobfuscated/);
    const f = inv.files.find((x) => x.path.startsWith("reconstructed/"))!;
    expect(f.provenance).toBe("reconstructed");
    expect(inv.files.some((x) => x.provenance === "recovered")).toBe(false);
    expect(inv.coverage.checks.find((c) => c.id === "deobfuscation")).toMatchObject({ status: "done" });
    expect(inv.evidence.some((e) => e.kind === "reconstructed" && e.method === "fake")).toBe(true);
  });
  it("is off by default: no engine call, no extra coverage check, no reconstructed files", async () => {
    let called = 0; const d: Deobfuscator = { deobfuscate: async () => { called++; return ok("x"); } };
    const inv = await run({}, d);
    expect(called).toBe(0); expect(inv.coverage.checks.some((c) => c.id === "deobfuscation")).toBe(false); expect(inv.files).toEqual([]);
  });
  it("requested but no engine available → the check is 'unavailable' and stated in the limits", async () => {
    const inv = await run({ deobfuscate: true });
    expect(inv.coverage.checks.find((c) => c.id === "deobfuscation")).toMatchObject({ status: "unavailable" });
    expect(inv.limitations.join("|")).toMatch(/deobfuscat/i);
  });
  it("an engine failure is a partial result with 'unavailable' evidence — the analysis still completes", async () => {
    const inv = await run({ deobfuscate: true }, { deobfuscate: async () => ({ ok: false, tool: "fake", unpacked: false, changed: false, notes: [], error: "boom" }) });
    expect(inv.status).toBe("done");
    expect(inv.coverage.checks.find((c) => c.id === "deobfuscation")?.status).toBe("partial");
    expect(inv.evidence.some((e) => e.kind === "unavailable" && /boom/.test(e.summary))).toBe(true);
  });
});
