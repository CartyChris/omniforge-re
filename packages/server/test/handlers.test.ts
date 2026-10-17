import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gzipSync, strToU8 } from "fflate";
// @ts-expect-error plain ESM fixture shared with core tests and e2e
import { createFixture } from "../../../fixtures/server.mjs";
import { analyzeHandler, clampConfig, forwardHandler, repoFilesHandler, repoInspectHandler, FORWARD_ALLOW } from "../src/handlers";
import { createGuardedAgent, nodeNet } from "../src/net";

const post = (path: string, body: unknown, signal?: AbortSignal) => new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal });

async function readSSE(res: Response) {
  const events: { event: string; data: any }[] = [];
  const text = await res.text();
  for (const block of text.split("\n\n")) {
    const ev = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
  }
  return events;
}

describe("analyze handler", () => {
  let fx: ReturnType<typeof createFixture>;
  let base: string;
  beforeAll(async () => { fx = createFixture(); base = await fx.listen(); });
  afterAll(async () => { await fx.close(); });

  it("hosted mode rejects private/metadata/loopback targets before any request", async () => {
    for (const t of ["http://127.0.0.1/", "http://localhost:3000", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "file:///etc/passwd", "http://10.0.0.1/"]) {
      const res = await analyzeHandler(post("/api/analyze", { targets: [t] }), { mode: "hosted" });
      expect(res.status, t).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    expect((await analyzeHandler(post("/api/analyze", { targets: [] }), { mode: "hosted" })).status).toBe(400);
    expect((await analyzeHandler(new Request("http://x/api/analyze"), { mode: "hosted" })).status).toBe(405);
    expect((await analyzeHandler(post("/api/analyze", { targets: Array(11).fill("https://example.com") }), { mode: "hosted" })).status).toBe(400);
  });

  it("local mode streams progress then the full investigation", async () => {
    const res = await analyzeHandler(post("/api/analyze", { targets: [base + "/"], config: { delayMs: 0, maxPages: 20 } }), { mode: "local" });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const ev = await readSSE(res);
    const updates = ev.filter((e) => e.event === "update");
    const done = ev.find((e) => e.event === "done")!;
    expect(updates.length).toBeGreaterThan(2);
    expect(updates.at(-1)!.data.counts.pages).toBeGreaterThan(5);
    expect(updates.flatMap((u) => u.data.pages).map((p: any) => new URL(p.url).pathname)).toContain("/products/widget"); // incremental page deltas
    expect(done.data.status).toBe("done");
    expect(done.data.pages.length).toBe(12);
    expect(done.data.files.map((f: any) => f.path).sort()).toEqual(["src/App.tsx", "src/api.ts"]);
    expect(ev.at(-1)!.event).toBe("done");
  }, 60_000);

  it("clamps hosted limits and never enables rendering", () => {
    const c = clampConfig({ maxPages: 99999, maxDepth: 50, concurrency: 500, maxAssetBytes: 1e9, delayMs: 0, render: true, allowedHosts: Array(20).fill("x.com") }, "hosted");
    expect(c).toMatchObject({ maxPages: 60, maxDepth: 4, concurrency: 6, maxAssetBytes: 5_000_000, delayMs: 50, render: false });
    expect(c.allowedHosts).toHaveLength(5);
    expect(clampConfig({ maxPages: 500 }, "local").maxPages).toBe(500);
  });

  it("enforces the hosted time budget and reports partial results honestly", async () => {
    const res = await analyzeHandler(post("/api/analyze", { targets: [base + "/"], config: { delayMs: 400, concurrency: 1 } }), { mode: "local", maxDurationMs: 700 });
    const done = (await readSSE(res)).find((e) => e.event === "done")!.data;
    expect(done.status).toBe("done");
    expect(done.limitations[0]).toMatch(/Time budget .* partial/);
    expect(done.pages.length).toBeLessThan(12);
  }, 30_000);

  it("stops when the client disconnects", async () => {
    const ctrl = new AbortController();
    const res = await analyzeHandler(post("/api/analyze", { targets: [base + "/"], config: { delayMs: 300, concurrency: 1 } }, ctrl.signal), { mode: "local" });
    setTimeout(() => ctrl.abort(), 200);
    const text = await res.text().catch(() => "");
    expect(text).not.toMatch(/event: done[\s\S]*"pages":\[(?:\{[^}]*\},?){12}\]/);
  }, 30_000);
});

describe("connect-time SSRF guard", () => {
  it("blocks a hostname that resolves to loopback even though no pre-flight literal check applies", async () => {
    const srv = http.createServer((_q, r) => r.end("SECRET")).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const port = (srv.address() as any).port;
    try {
      const strict = nodeNet({ allowPrivate: false });
      await expect(strict.fetch(`http://localhost:${port}/`)).rejects.toThrow();
      const err = await strict.fetch(`http://localhost:${port}/`).catch((e) => e);
      expect(String(err?.cause?.message ?? err?.message)).toMatch(/Blocked: localhost resolves to .* \(loopback/);
      const lax = nodeNet({ allowPrivate: true });
      expect(await (await lax.fetch(`http://localhost:${port}/`)).text()).toBe("SECRET");
    } finally { srv.close(); }
    expect(createGuardedAgent()).toBeTruthy();
  });
});

describe("repo handlers (mock GitHub)", () => {
  let srv: http.Server, base: string;
  const MIT = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy";
  function tar(root: string, files: Record<string, string>) {
    const blocks: Uint8Array[] = [];
    for (const [n, body] of Object.entries(files)) {
      const h = new Uint8Array(512); const b = strToU8(body);
      h.set(strToU8(`${root}/${n}`), 0); h.set(strToU8(b.length.toString(8).padStart(11, "0") + "\0"), 124); h[156] = 48; h.set(strToU8("ustar\0"), 257);
      blocks.push(h); const p = new Uint8Array(Math.ceil(b.length / 512) * 512); p.set(b); blocks.push(p);
    }
    blocks.push(new Uint8Array(1024));
    const out = new Uint8Array(blocks.reduce((a, b) => a + b.length, 0)); let o = 0; for (const b of blocks) { out.set(b, o); o += b.length; }
    return gzipSync(out);
  }
  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === "/repos/o/lic") { res.writeHead(200); return res.end(JSON.stringify({ default_branch: "main", description: "d", stargazers_count: 1, private: false })); }
      if (req.url === "/repos/o/nolic") { res.writeHead(200); return res.end(JSON.stringify({ default_branch: "main" })); }
      if (req.url === "/o/lic/tar.gz/main" || req.url === "/repos/o/lic/tarball/main") { res.writeHead(200); return res.end(tar("lic-abcdef1", { LICENSE: MIT, "package.json": '{"name":"x","dependencies":{"next":"15"}}', "app/page.tsx": "export default function P(){return null}" })); }
      if (req.url === "/o/nolic/tar.gz/main" || req.url === "/repos/o/nolic/tarball/main") { res.writeHead(200); return res.end(tar("nolic-1234567", { "README.md": "hi", "a.js": "1" })); }
      res.writeHead(404); res.end("{}");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as any).port}`;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));
  const opts = () => ({ mode: "hosted" as const, repoFetch: { allowAnyHost: true, baseUrls: { api: base, codeload: base } } });

  it("inspects several repos, reports licences + a combined assessment, and tolerates a bad one", async () => {
    const res = await repoInspectHandler(post("/api/repo/inspect", { urls: ["o/lic", "o/nolic", "o/missing", "not a url"], token: "ghp_supersecret", purpose: "mesh" }), opts());
    const txt = await res.text();
    expect(txt).not.toContain("ghp_supersecret"); // tokens are never echoed
    const j = JSON.parse(txt);
    expect(j.repos.map((r: any) => r.ok)).toEqual([true, true, false, false]);
    const lic = j.repos[0];
    expect(lic).toMatchObject({ files: 3, sha: "abcdef1", frameworks: ["Next.js"], effective: { spdx: "MIT", class: "permissive" } });
    expect(j.repos[1].effective).toMatchObject({ spdx: "NONE", class: "none" });
    expect(j.repos[2].error).toMatch(/not found/i);
    expect(j.assessment.requiresAttestation).toBe(true); // because of o/nolic
    expect(j.assessment.perRepo).toHaveLength(2);
  });
  it("streams a repo's files as NDJSON with a header line", async () => {
    const res = await repoFilesHandler(post("/api/repo/files", { url: "o/lic" }), opts());
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].header).toMatchObject({ sha: "abcdef1", count: 3, licenses: [{ spdx: "MIT" }, { spdx: "MIT" }].slice(0, 1) });
    const byPath = Object.fromEntries(lines.slice(1).map((l: any) => [l.path, Buffer.from(l.b64, "base64").toString()]));
    expect(byPath["app/page.tsx"]).toContain("export default");
    expect(Object.keys(byPath).sort()).toEqual(["LICENSE", "app/page.tsx", "package.json"]);
    expect((await repoFilesHandler(post("/api/repo/files", { url: "o/missing" }), opts())).status).toBe(502);
    expect((await repoFilesHandler(post("/api/repo/files", { url: "ftp://x/y" }), opts())).status).toBe(400);
  });
});

describe("forward handler (hosted allow-list)", () => {
  const stub = (seen: any[], status = 200, headers: Record<string, string> = {}) => ({ fetch: (async (u: string, init: any) => { seen.push({ u, init }); return new Response("ok-body", { status, headers: { "content-type": "application/json", ...headers } }); }) as never, dispatcher: {}, resolver: async () => ["1.2.3.4"], allowPrivate: false });
  it("forwards to allow-listed API hosts, stripping cookies and unknown headers", async () => {
    const seen: any[] = [];
    const res = await forwardHandler(post("/api/forward", { url: "https://api.anthropic.com/v1/messages", method: "POST", headers: { "x-api-key": "k", cookie: "session=1", "x-evil": "1", "content-type": "application/json" }, body: "{}" }), { mode: "hosted", net: stub(seen) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok-body");
    expect(seen[0].init.headers).toEqual({ "x-api-key": "k", "content-type": "application/json" });
    expect(seen[0].init.redirect).toBe("manual");
  });
  it("is NOT an open proxy: unknown hosts, private hosts and http are refused", async () => {
    const seen: any[] = [];
    for (const [url, status] of [["https://evil.example.com/x", 403], ["http://169.254.169.254/", 400], ["https://localhost/", 400], ["http://api.openai.com/v1/models", 400], ["ftp://api.openai.com", 400]] as const) {
      expect((await forwardHandler(post("/api/forward", { url }), { mode: "hosted", net: stub(seen) })).status, url).toBe(status);
    }
    expect(seen).toEqual([]); // nothing was fetched
    expect(FORWARD_ALLOW.has("api.anthropic.com") && FORWARD_ALLOW.has("api.vercel.com") && FORWARD_ALLOW.has("api.github.com")).toBe(true);
  });
  it("does not follow upstream redirects and passes status codes through", async () => {
    expect((await forwardHandler(post("/api/forward", { url: "https://api.openai.com/v1/x" }), { mode: "hosted", net: stub([], 302, { location: "http://internal/" }) })).status).toBe(502);
    expect((await forwardHandler(post("/api/forward", { url: "https://api.openai.com/v1/x" }), { mode: "hosted", net: stub([], 429, { "retry-after": "7" }) })).headers.get("retry-after")).toBe("7");
  });
});
