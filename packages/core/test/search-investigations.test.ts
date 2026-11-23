import { describe, expect, it } from "vitest";
import { CHUNK_TAB, searchInvestigations } from "../src/ai/retrieval";
import type { Investigation } from "../src/schema";

const base = { targets: [], assets: [], technologies: [], dependencies: [], features: [], findings: [], graph: { nodes: [], edges: [] }, coverage: { score: 1, checks: [] }, limitations: [], questions: [], log: [] };
const ev = (id: string, summary: string) => ({ id, kind: "observed", method: "http-get", source: "https://x.test/", timestamp: "", confidence: 0.9, summary });

const shop = {
  ...base, id: "inv_shop", name: "Shop", pages: [], files: [],
  evidence: [ev("ev_s1", "Checkout posts card details to Stripe Elements"), ev("ev_s2", "Header has a cart counter badge"), ev("ev_s3", "Footer lists payment logos")],
  endpoints: [{ url: "https://shop.test/api/cart/items", method: "POST", kind: "rest", foundIn: "app.js", evidence: "ev_s2" }],
} as unknown as Investigation;

const blog = {
  ...base, id: "inv_blog", name: "Blog", pages: [], endpoints: [],
  evidence: [ev("ev_b1", "Comments are powered by Disqus embed"), ev("ev_b2", "Header has a dark mode toggle"), ev("ev_b3", "Footer has an RSS feed link")],
  files: [{ path: "src/newsletter/subscribe.ts", size: 40, content: "export async function subscribe(email: string) { return fetch('/api/mailchimp', { method: 'POST' }); }" }],
} as unknown as Investigation;

describe("searchInvestigations", () => {
  it("ranks the matching investigation's chunk first for distinct queries", () => {
    const stripe = searchInvestigations([shop, blog], "stripe", 5);
    expect(stripe[0]).toMatchObject({ investigationId: "inv_shop", investigationName: "Shop", kind: "evidence", chunkId: "ev_s1" });
    const disqus = searchInvestigations([shop, blog], "Disqus comments", 5);
    expect(disqus[0]).toMatchObject({ investigationId: "inv_blog", investigationName: "Blog", kind: "evidence", chunkId: "ev_b1" });
    const mail = searchInvestigations([shop, blog], "mailchimp", 5);
    expect(mail[0]).toMatchObject({ investigationId: "inv_blog", kind: "file" });
    expect(mail[0]!.label).toContain("src/newsletter/subscribe.ts");
    const cart = searchInvestigations([blog, shop], "cart items endpoint", 5); // order of the input does not decide the winner
    expect(cart[0]!.investigationId).toBe("inv_shop");
    expect(cart[0]!.kind).toBe("endpoint");
    expect(CHUNK_TAB[cart[0]!.kind]).toBe("apis");
  });

  it("returns a snippet containing the query term", () => {
    for (const [q, term] of [["stripe", "stripe"], ["Disqus", "disqus"], ["mailchimp", "mailchimp"]] as const) {
      const [hit] = searchInvestigations([shop, blog], q, 3);
      expect(hit!.snippet.toLowerCase()).toContain(term);
      expect(hit!.snippet.length).toBeLessThanOrEqual(170);
    }
  });

  it("respects k and returns nothing for no match or empty query", () => {
    const all = searchInvestigations([shop, blog], "header footer", 50);
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(new Set(all.map((h) => h.investigationId))).toEqual(new Set(["inv_shop", "inv_blog"]));
    expect(searchInvestigations([shop, blog], "header footer", 2)).toHaveLength(2);
    expect(searchInvestigations([shop, blog], "header footer", 0)).toHaveLength(0);
    expect(searchInvestigations([shop, blog], "zzqxnomatch", 5)).toHaveLength(0);
    expect(searchInvestigations([shop, blog], "  ", 5)).toHaveLength(0);
    expect(searchInvestigations([], "stripe", 5)).toHaveLength(0);
  });
});
