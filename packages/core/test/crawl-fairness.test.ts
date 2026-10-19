/** maxPages is spent fairly: 80 product links listed first must not crowd out the site's distinct pages. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { investigate, urlTemplate } from "../src/crawl/investigate";

const html = (title: string, links: string[]) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${links.map((l) => `<a href="${l}">${l}</a>`).join(" ")}</main></body></html>`;
const PRODUCTS = Array.from({ length: 80 }, (_, i) => `/products/item-${i}`);
const DISTINCT = ["/pricing", "/about", "/login", "/docs", "/contact"];
let server: http.Server; let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const p = new URL(req.url!, "http://x").pathname;
    if (p === "/robots.txt" || p.startsWith("/sitemap")) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/html" }).end(p === "/" ? html("Shop", [...PRODUCTS, ...DISTINCT]) : html(p, ["/"]));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
const paths = (inv: Awaited<ReturnType<typeof investigate>>) => inv.pages.map((p) => new URL(p.url).pathname);

describe("crawl budget fairness", () => {
  it("collapses ids and sibling slugs into one template", () => {
    expect(urlTemplate("https://a.test/products/blue-shoe")).toBe(urlTemplate("https://a.test/products/red-hat"));
    expect(urlTemplate("https://a.test/u/123/posts")).toBe(urlTemplate("https://a.test/u/456/posts"));
    expect(urlTemplate("https://a.test/pricing")).not.toBe(urlTemplate("https://a.test/about"));
  });

  it("reaches every distinct page within a small page budget", async () => {
    const inv = await investigate({ targets: [base + "/"], allowPrivate: true, config: { delayMs: 0, concurrency: 4, maxPages: 15, followSitemaps: false } });
    const got = paths(inv);
    expect(got.length).toBeLessThanOrEqual(15);
    for (const d of DISTINCT) expect(got).toContain(d);
    expect(got.filter((p) => p.startsWith("/products/")).length).toBeGreaterThan(0);
    expect(inv.coverage.checks.length).toBeGreaterThan(0);
  });

  it("still spends leftover budget on the deferred same-template pages", async () => {
    const inv = await investigate({ targets: [base + "/"], allowPrivate: true, config: { delayMs: 0, concurrency: 4, maxPages: 200, followSitemaps: false } });
    expect(paths(inv).filter((p) => p.startsWith("/products/")).length).toBe(80);
    expect(paths(inv).length).toBe(1 + 80 + DISTINCT.length);
  });
});
