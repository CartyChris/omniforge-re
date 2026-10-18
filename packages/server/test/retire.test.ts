import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM fixture shared with core tests and e2e
import { createFixture } from "../../../fixtures/server.mjs";
import { analyzeHandler } from "../src/handlers";
import { clearRetireCache, loadRetireRepository } from "../src/retire";

const EXCERPT = fs.readFileSync(new URL("../../core/test/fixtures/retire/jsrepository-excerpt.json", import.meta.url), "utf8");
const post = (body: unknown) => new Request("http://localhost/api/analyze", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const done = async (res: Response) => { const t = await res.text(); const m = [...t.matchAll(/event: done\ndata: (.+)\n/g)].at(-1); return JSON.parse(m![1]!); };
const stub = (body: string | (() => Response), counter = { n: 0 }) => ((async () => { counter.n++; return typeof body === "function" ? body() : new Response(body, { headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch);

beforeEach(() => clearRetireCache());

describe("retire.js repository loader", () => {
  it("fetches once, validates and caches for a day; a later failure does not discard a good cache", async () => {
    const c = { n: 0 }; const f = stub(EXCERPT, c);
    const a = await loadRetireRepository({ fetch: f, now: () => 1000 });
    expect(a.repo).toBeTruthy(); expect(a.stats!.components).toBeGreaterThan(5);
    await loadRetireRepository({ fetch: f, now: () => 1000 + 3600_000 });
    expect(c.n).toBe(1);
    const failing = stub(() => new Response("no", { status: 503 }), c);
    const b = await loadRetireRepository({ fetch: failing, now: () => 1000 + 3600_000 });
    expect(b.repo).toBeTruthy(); expect(c.n).toBe(1); // served from cache, still within the day
    const after = await loadRetireRepository({ fetch: failing, now: () => 1000 + 25 * 3600_000 });
    expect(after.repo).toBeUndefined(); expect(after.error).toMatch(/HTTP 503/);
  });
  it("reports (never throws) for HTTP errors, junk, wrong shapes and oversized bodies", async () => {
    expect((await loadRetireRepository({ fetch: stub("<html>") })).error).toMatch(/could not be loaded/);
    clearRetireCache(); expect((await loadRetireRepository({ fetch: stub("[]") })).error).toMatch(/Not a retire\.js repository/);
    clearRetireCache(); expect((await loadRetireRepository({ fetch: stub("{}") })).error).toMatch(/no usable detection rules/);
    clearRetireCache(); expect((await loadRetireRepository({ fetch: stub(() => new Response("x".repeat(6_000_001))) })).error).toMatch(/larger than the 6 MB limit/);
    clearRetireCache(); expect((await loadRetireRepository({ fetch: (async () => { throw new Error("offline"); }) as never })).error).toMatch(/offline/);
  });
  it("concurrent callers share one request", async () => {
    const c = { n: 0 }; const f = stub(EXCERPT, c);
    await Promise.all([loadRetireRepository({ fetch: f }), loadRetireRepository({ fetch: f }), loadRetireRepository({ fetch: f })]);
    expect(c.n).toBe(1);
  });
});

describe("analyze handler + library detection", () => {
  let fx: ReturnType<typeof createFixture>; let base: string;
  beforeAll(async () => { fx = createFixture(); base = await fx.listen(); });
  afterAll(async () => { await fx.close(); });
  const cfg = { delayMs: 0, maxPages: 1, maxDepth: 0 };

  it("returns identified libraries and a finding when the rules load", async () => {
    const inv = await done(await analyzeHandler(post({ targets: [base + "/legacy"], config: cfg }), { mode: "local", retireFetch: stub(EXCERPT) }));
    expect(inv.libraries).toEqual([expect.objectContaining({ component: "jquery", version: "1.12.4" })]);
    expect(inv.findings.map((f: { title: string }) => f.title)).toContain("Known vulnerabilities in jquery 1.12.4");
    expect(inv.limitations.join(" ")).not.toMatch(/Library version detection/);
  });
  it("says so — and still completes — when the rules cannot be loaded", async () => {
    const inv = await done(await analyzeHandler(post({ targets: [base + "/legacy"], config: cfg }), { mode: "local", retireFetch: stub(() => new Response("", { status: 500 })) }));
    expect(inv.status).toBe("done"); expect(inv.libraries).toBeUndefined();
    expect(inv.limitations).toContainEqual(expect.stringMatching(/Library version detection was skipped: .*HTTP 500/));
  });
  it("does not even contact the rules host when the user turned the step off", async () => {
    const c = { n: 0 };
    const inv = await done(await analyzeHandler(post({ targets: [base + "/legacy"], config: { ...cfg, identifyLibraries: false } }), { mode: "local", retireFetch: stub(EXCERPT, c) }));
    expect(c.n).toBe(0); expect(inv.libraries).toBeUndefined();
  });
});
