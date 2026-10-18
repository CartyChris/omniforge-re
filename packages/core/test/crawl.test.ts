import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM fixture shared with the e2e suite
import { createFixture } from "../../../fixtures/server.mjs";
import { investigate } from "../src/crawl/investigate";
import { parseRepository } from "../src/analyze/retire";
import fs from "node:fs";
import { BlockedUrlError } from "../src/net/ssrf";
import { safeFetch } from "../src/net/fetch";
import type { Investigation } from "../src/schema";

let fx: ReturnType<typeof createFixture>;
let base: string;
beforeAll(async () => { fx = createFixture(); base = await fx.listen(); });
afterAll(async () => { await fx.close(); });

const run = (o: Partial<Parameters<typeof investigate>[0]> = {}) => investigate({ targets: [base + "/"], allowPrivate: true, config: { delayMs: 0, concurrency: 4 }, ...o });
const paths = (inv: Investigation) => inv.pages.map((p) => new URL(p.url).pathname).sort();

describe("full-domain crawl of the controlled fixture site", () => {
  let inv: Investigation;
  beforeAll(async () => { fx.hits.length = 0; inv = await run(); }, 60_000);

  it("discovers exactly the expected pages (links + sitemap + bundle route; redirect de-duplicated)", () => {
    expect(inv.status).toBe("done");
    expect(paths(inv)).toEqual(["/", "/about", "/about/team", "/contact", "/docs/getting-started", "/login", "/privacy", "/products", "/products/gadget", "/products/widget", "/settings", "/sitemap-only"]);
    expect(new Set(inv.pages.map((p) => p.url)).size).toBe(inv.pages.length); // no duplicates
    expect(inv.pages.find((p) => p.url.endsWith("/sitemap-only"))!.discoveredVia).toBe("sitemap");
    expect(inv.pages.find((p) => p.url.endsWith("/settings"))!.discoveredVia).toBe("bundle-route");
    expect(inv.pages.find((p) => p.url.endsWith("/about/team"))!.depth).toBe(2);
  });

  it("honours robots.txt and never fetches the disallowed path", () => {
    expect(fx.hits).not.toContain("/admin/secret");
    expect(inv.findings.some((f) => /robots\.txt disallows/.test(f.title))).toBe(true);
  });

  it("never leaves scope or fetches the off-site link", () => {
    expect(inv.pages.every((p) => p.url.startsWith(base))).toBe(true);
    expect(fx.hits).not.toContain("/offsite");
  });

  it("inventories assets and recovers original source from the declared source map", () => {
    const urls = inv.assets.map((a) => a.url.replace(base, ""));
    expect(urls).toEqual(expect.arrayContaining(["/static/app.js", "/static/app.css", "/manifest.webmanifest", "/static/app.js.map", "/static/inter.woff2", "/static/hero.png", "/static/logo.svg", "/static/team.png", "/sw.js"]));
    const js = inv.assets.find((a) => a.url.endsWith("/static/app.js"))!;
    expect(js).toMatchObject({ kind: "script", fetched: true, status: 200 });
    expect(js.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inv.files.map((f) => f.path).sort()).toEqual(["src/App.tsx", "src/api.ts"]);
    expect(inv.files.every((f) => f.provenance === "recovered" && f.hash.length === 64)).toBe(true);
    const mapEv = inv.evidence.find((e) => e.method === "sourcemap")!;
    expect(mapEv.kind).toBe("recovered");
    expect(mapEv.summary).toMatch(/Recovered 2 original source/);
  });

  it("fingerprints only what the evidence supports", () => {
    const names = inv.technologies.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["Express", "React", "Service Worker", "WebSocket", "PWA"]));
    expect(names).not.toContain("Next.js");
    expect(names).not.toContain("Vue.js");
    for (const t of inv.technologies) {
      expect(t.evidence.length).toBeGreaterThan(0);
      for (const id of t.evidence) expect(inv.evidence.some((e) => e.id === id)).toBe(true); // every claim resolves to stored evidence
    }
  });

  it("extracts API endpoints from the bundle AST", () => {
    const eps = inv.endpoints.map((e) => `${e.kind}:${e.method ?? "-"}:${e.url.replace(base, "")}`);
    expect(eps).toEqual(expect.arrayContaining(["rest:GET:/api/users", "rest:POST:/api/items", "websocket:-:wss://rt.fixture.test/socket"]));
  });

  it("builds an evidence-linked feature inventory with honest specs", () => {
    const by = Object.fromEntries(inv.features.map((f) => [f.name, f]));
    for (const n of ["Site navigation", "Authentication", "Search", "File upload", "Data tables", "Modal dialogs", "Installable / offline app (PWA)", "Realtime updates"]) expect(by[n], n).toBeTruthy();
    expect(by["Authentication"]!.spec.inputs).toEqual(expect.arrayContaining([expect.stringContaining("email"), expect.stringContaining("password")]));
    expect(by["Authentication"]!.spec.outputs.join()).toMatch(/Unknown/);
    for (const f of inv.features) for (const id of f.evidence) expect(inv.evidence.some((e) => e.id === id), `${f.name} evidence ${id}`).toBe(true);
  });

  it("derives passive findings (cookie flags, security headers, a11y) with evidence", () => {
    const titles = inv.findings.map((f) => f.title).join("\n");
    expect(titles).toMatch(/Content-Security-Policy/);
    expect(titles.match(/Cookie “sid”/g)).toHaveLength(1); // de-duplicated across pages
    expect(titles).toMatch(/Cookie “sid”: no SameSite attribute/);
    expect(titles).not.toMatch(/no Secure flag/); // fixture is plain http: Secure is not applicable
    expect(titles).toMatch(/12 page\(s\): no canonical link/); // grouped, not 12 separate findings
    expect(titles).toMatch(/image\(s\) without alt/);
    for (const f of inv.findings) expect(f.evidence.length).toBeGreaterThan(0);
  });

  it("computes coverage from real checks and lists what is unavailable", () => {
    const c = Object.fromEntries(inv.coverage.checks.map((x) => [x.id, x]));
    expect(c.pages!.status).toBe("done");
    expect(c.sourcemaps!.status).toBe("done");
    expect(c.render!.status).toBe("skipped");
    expect(c.auth!.status).toBe("unavailable");
    expect(c.server!.status).toBe("unavailable");
    expect(inv.coverage.score).toBeGreaterThan(0.5);
    expect(inv.coverage.score).toBeLessThan(1);
    expect(inv.limitations.join("\n")).toMatch(/Server-side logic/);
  });

  it("builds a connected graph", () => {
    const ids = new Set(inv.graph.nodes.map((n) => n.id));
    expect(inv.graph.nodes.filter((n) => n.type === "page")).toHaveLength(12);
    expect(inv.graph.edges.length).toBeGreaterThan(15);
    for (const e of inv.graph.edges) { expect(ids.has(e.source)).toBe(true); expect(ids.has(e.target)).toBe(true); }
  });
});

describe("crawl settings", () => {
  it("single-page mode fetches exactly one page", async () => {
    const inv = await run({ config: { mode: "single", delayMs: 0 } });
    expect(paths(inv)).toEqual(["/"]);
  });
  it("maxPages is a hard limit and is reported", async () => {
    const inv = await run({ config: { maxPages: 3, delayMs: 0, followSitemaps: false } });
    expect(inv.pages.length).toBe(3);
    expect(inv.findings.some((f) => /page limit/.test(f.title))).toBe(true);
    expect(inv.coverage.checks.find((c) => c.id === "pages")!.status).toBe("partial");
  });
  it("maxDepth bounds link following", async () => {
    const inv = await run({ config: { maxDepth: 1, delayMs: 0, followSitemaps: false } });
    expect(inv.pages.every((p) => p.depth <= 1)).toBe(true);
    expect(paths(inv)).not.toContain("/about/team");
  });
  it("can ignore robots.txt only when the user turns it off", async () => {
    fx.hits.length = 0;
    await run({ config: { respectRobots: false, delayMs: 0 } });
    expect(fx.hits).toContain("/admin/secret");
  });
  it("skips asset fetching when disabled", async () => {
    const inv = await run({ config: { fetchAssets: false, delayMs: 0, mode: "single" } });
    expect(inv.assets.every((a) => !a.fetched)).toBe(true);
    expect(inv.files).toHaveLength(0);
  });
  it("can be cancelled and reports it", async () => {
    const ctrl = new AbortController();
    const p = run({ signal: ctrl.signal, config: { delayMs: 200 } });
    setTimeout(() => ctrl.abort(), 150);
    const inv = await p;
    expect(inv.status).toBe("cancelled");
  });
  it("streams progress updates", async () => {
    const seen: number[] = [];
    await run({ onUpdate: (i) => seen.push(i.pages.length), config: { delayMs: 30 } });
    expect(seen.length).toBeGreaterThan(2);
    expect(Math.max(...seen)).toBe(12);
  });
});

describe("SSRF at the pipeline boundary", () => {
  it("rejects hostile seeds before any request", async () => {
    for (const t of ["http://169.254.169.254/latest/meta-data/", "http://localhost:3000/", "file:///etc/passwd", "http://[::1]/"]) {
      await expect(investigate({ targets: [t] })).rejects.toThrow(BlockedUrlError);
    }
  });
  it("revalidates every redirect hop (public host redirecting to cloud metadata)", async () => {
    const calls: string[] = [];
    const fakeFetch = async (u: string) => {
      calls.push(u);
      if (u.startsWith("https://good.example.com")) return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      return new Response("SECRET", { status: 200 });
    };
    await expect(safeFetch("https://good.example.com/", { fetch: fakeFetch, resolver: async () => ["93.184.216.34"] })).rejects.toThrow(/link-local|metadata/i);
    expect(calls).toEqual(["https://good.example.com/"]); // the metadata URL was never requested
  });
  it("blocks a hostname that resolves to a private address", async () => {
    await expect(investigate({ targets: ["https://rebind.example.com/"], resolver: async () => ["10.1.2.3"], fetch: (async () => new Response("")) as never })).resolves.toMatchObject({ pages: [] });
  });
});

describe("library version detection during a crawl (retire.js rules supplied by the host)", () => {
  const { repo } = parseRepository(JSON.parse(fs.readFileSync(new URL("./fixtures/retire/jsrepository-excerpt.json", import.meta.url), "utf8")));
  it("identifies the real jQuery 1.12.4 file, records evidence, a dependency, a technology and a security finding that cites it", async () => {
    const inv = await investigate({ targets: [base + "/legacy"], allowPrivate: true, config: { delayMs: 0, concurrency: 2, maxPages: 1 }, retire: repo });
    expect(inv.libraries).toEqual([expect.objectContaining({ component: "jquery", version: "1.12.4", detection: "filecontent", source: `${base}/static/vendor/jquery-1.12.4.min.js` })]);
    expect(inv.libraries![0]!.vulnerabilities.flatMap((v) => v.ids)).toContain("CVE-2020-11022");
    expect(inv.technologies.find((t) => t.name === "jquery")).toMatchObject({ version: "1.12.4", category: "JavaScript library" });
    expect(inv.dependencies).toContainEqual(expect.objectContaining({ name: "jquery", version: "1.12.4", ecosystem: "npm" }));
    const f = inv.findings.find((x) => x.title === "Known vulnerabilities in jquery 1.12.4")!;
    expect(f).toMatchObject({ area: "security", severity: "medium", detail: expect.stringMatching(/not that the site is exploitable/) });
    const ev = inv.evidence.find((e) => f.evidence.includes(e.id))!;
    expect(ev).toMatchObject({ kind: "observed", method: "retire.js" });
    expect(inv.libraries!.some((l) => l.component !== "jquery")).toBe(false); // the plain bundle is not mislabelled
  }, 60_000);
  it("is skipped (no libraries field, no findings of that kind) when the host supplies no rules", async () => {
    const inv = await investigate({ targets: [base + "/legacy"], allowPrivate: true, config: { delayMs: 0, concurrency: 2, maxPages: 1 } });
    expect(inv.libraries).toBeUndefined();
    expect(inv.findings.some((f) => f.title.startsWith("Known vulnerabilities in"))).toBe(false);
  }, 60_000);
});
