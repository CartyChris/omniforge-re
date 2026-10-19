import { describe, expect, it } from "vitest";
import { buildIndex, investigationChunks, relevantContext, search, tokenize } from "../src/ai/retrieval";
import { siteBrief } from "../src/ai/plans";
import { investigateSource } from "../src/analyze/sourceInvestigation";
import type { Evidence, Investigation, Page } from "../src/schema";

const file = (path: string, content: string) => ({ path, data: new TextEncoder().encode(content) });

/** A site investigation big enough that the old "first 120 evidence items" context could not see most of it. */
function bigSite(): Investigation {
  // distractors share the questions' words (checkout, search, card, newsletter, return, cart, days) so matching any word is not enough
  const topics = ["checkout button in the header", "search icon", "product card layout", "newsletter link in the footer", "return-to-top link", "cart counter badge", "sale banner (3 days left)", "payment logos in the footer"];
  const evidence: Evidence[] = Array.from({ length: 320 }, (_, i) => ({ id: `ev_${String(i).padStart(3, "0")}`, kind: "observed", method: "http-get", source: `https://shop.test/p/${i}`, timestamp: "", confidence: 0.9, summary: `Page ${i} has a ${topics[i % topics.length]}` }));
  // the facts the questions are about, deliberately late in the ledger
  evidence[250] = { ...evidence[250]!, summary: "Checkout posts card details to Stripe Elements (js.stripe.com/v3) — no card field reaches the site's own server" };
  evidence[287] = { ...evidence[287]!, summary: "Search box queries Algolia index products_prod with typo tolerance", snippet: "algoliasearch('XYZ', '…').initIndex('products_prod')" };
  evidence[301] = { ...evidence[301]!, summary: "Newsletter signup is handled by Mailchimp embedded form (list u=…)" };
  const page = (i: number, path: string, title: string, text?: string): Page => ({ id: `pg_${i}`, url: `https://shop.test${path}`, status: 200, title, depth: 1, contentType: "text/html", bytes: 1, hash: "", ms: 1, discoveredVia: "link", links: [], scripts: [], styles: [], images: [], forms: [], headings: [{ level: 1, text: title }], landmarks: [], meta: {}, interactive: { buttons: 0, inputs: 0, dialogs: 0, links: 0 }, a11y: { imagesWithoutAlt: 0, inputsWithoutLabel: 0, hasLang: true, hasMain: true }, text });
  const pages = Array.from({ length: 40 }, (_, i) => page(i, `/p/${i}`, `Product ${i}`, `# Product ${i}\n\nA fine product. ${"Lorem ipsum dolor sit amet. ".repeat(20)}`));
  pages.push(page(90, "/returns", "Returns policy", `# Returns\n\n${"General terms apply. ".repeat(80)}\n\nYou can return unworn shoes within 45 days for a full refund; sale items are final.`));
  return { id: "inv1", name: "shop", targets: [{ kind: "url", value: "https://shop.test" }], pages, assets: [], technologies: [], files: [], dependencies: [], endpoints: [{ url: "https://shop.test/api/cart/items", method: "POST", kind: "rest", foundIn: "app.js", evidence: "ev_000" }], features: [], findings: [], evidence, graph: { nodes: [], edges: [] }, coverage: { score: 1, checks: [] }, limitations: [], questions: [], log: [] } as unknown as Investigation;
}

/** Labelled questions → the chunk id that answers each. Written before looking at scores. */
const LABELLED: [string, string][] = [
  ["How are card payments processed at checkout?", "ev_250"],
  ["Which search provider powers the search box?", "ev_287"],
  ["What handles newsletter signups?", "ev_301"],
  ["How many days do customers have to return shoes?", "pg_90#"],
  ["What endpoint adds items to the cart?", "POST https://shop.test/api/cart/items"],
];

describe("retrieval for Ask", () => {
  it("tokenizes identifiers, paths and plurals so code matches plain words", () => {
    expect(tokenize("getUserProfile /api/v2/user_settings HTTPServer endpoints")).toEqual(["get", "user", "profile", "api", "v2", "user", "setting", "http", "server", "endpoint"]);
  });

  it("finds the answering passage for every labelled question (recall@5 = 1), where the old fixed context could not", () => {
    const inv = bigSite(); const ix = buildIndex(investigationChunks(inv));
    let hits = 0;
    for (const [q, want] of LABELLED) { const top = search(ix, q, 5).map((r) => r.chunk.id); if (top.some((id) => id.startsWith(want))) hits++; else console.error(q, top); }
    expect(hits / LABELLED.length).toBe(1);
    // baseline: the previous prompt carried evidence 0..119 and page text of the 8 shallowest pages only
    const oldEvidence = new Set(inv.evidence.slice(0, 120).map((e) => e.id));
    expect(["ev_250", "ev_287", "ev_301"].filter((id) => oldEvidence.has(id))).toEqual([]);
  });

  it("returns fenced passages within budget and puts the answer in them", () => {
    const r = relevantContext(bigSite(), "How many days do customers have to return shoes?", { budget: 3_000 });
    expect(r.text.startsWith("<<<UNTRUSTED_DATA")).toBe(true);
    expect(r.text).toContain("45 days");
    expect(r.text.length).toBeLessThan(3_400);
  });

  it("uses recent questions so a follow-up still retrieves its subject", () => {
    const r = relevantContext(bigSite(), "and is that third party GDPR compliant?", { history: "Which search provider powers the search box?" });
    expect(r.hits.map((h) => h.id)).toContain("ev_287");
  });

  it("returns nothing (not noise) when no word of the question occurs", () => {
    expect(relevantContext(bigSite(), "zzqx wvvy").text).toBe("");
  });

  it("indexes source files by window with file:line labels", async () => {
    const big = Array.from({ length: 200 }, (_, i) => `export const filler${i} = ${i};`).join("\n") + "\nexport function applyCoupon(code: string) { return code === 'SPRING25' ? 0.25 : 0; }\n";
    const inv = await investigateSource("repo", [file("src/pricing.ts", big), file("README.md", "# Shop\n")], { kind: "files" });
    const r = search(buildIndex(investigationChunks(inv)), "how does applying a coupon code work", 3);
    expect(r[0]!.chunk.kind).toBe("file");
    expect(r[0]!.chunk.label).toMatch(/^src\/pricing\.ts:\d+$/);
    expect(r[0]!.chunk.text).toContain("SPRING25");
  });
});

describe("rebuild brief for source investigations", () => {
  it("includes the file tree, dependencies and key files (README and manifest before leaf modules)", async () => {
    const inv = await investigateSource("repo", [
      file("src/utils/strings.ts", "export const pad = (s: string) => s.padStart(2);\n"),
      file("package.json", JSON.stringify({ name: "shop", dependencies: { express: "^5.1.0" } })),
      file("README.md", "# Shop API\n\nServes the catalogue and cart.\n"),
      file("src/server.ts", "import express from 'express';\nconst app = express();\napp.get('/api/products', (_req, res) => res.json([]));\napp.listen(3000);\n"),
    ], { kind: "files" });
    const b = siteBrief(inv);
    expect(b).toContain("SOURCE FILES (4)");
    expect(b).toMatch(/DEPENDENCIES\n.*express/);
    expect(b).toContain("KEY SOURCE");
    const key = b.slice(b.indexOf("KEY SOURCE"));
    expect(key.indexOf("--- README.md")).toBeGreaterThan(-1);
    expect(key.indexOf("--- README.md")).toBeLessThan(key.indexOf("--- package.json"));
    expect(key.indexOf("--- package.json")).toBeLessThan(key.indexOf("--- src/server.ts"));
    expect(key.indexOf("--- src/server.ts")).toBeLessThan(key.indexOf("--- src/utils/strings.ts"));
    expect(key).toContain("app.get('/api/products'");
    expect(b.endsWith(">>>")).toBe(true); // still fenced as one block
  });

  it("stays within its size cap on a large repo", async () => {
    const files = Array.from({ length: 300 }, (_, i) => file(`src/m${i}.ts`, `export const v${i} = "${"x".repeat(3_000)}";\n`));
    const b = siteBrief(await investigateSource("big", files, { kind: "files" }), 22_000);
    expect(b.length).toBeLessThan(22_300);
    expect(b).toContain("first 200");
  });
});
