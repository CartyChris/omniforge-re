// PoC (2026-10-18): reference-vs-rebuild comparison. Playwright-core + pixelmatch + looks-same clusters + axe + DOM/ARIA facts.
// Verified: runs under Node 22.22 AND as `bun build --compile pipe.mjs --external "chromium-bidi/*" --external electron` (Bun 1.4.2) executed from a cwd with no node_modules.
// Deps: playwright-core@1.64.1 pngjs pixelmatch@8 looks-same@10 @axe-core/playwright@4.14 (install with --ignore-scripts). Needs a Chromium: set CHROME_PATH.
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import looksSame from "looks-same";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

const REF = `<!doctype html><html lang="en"><head><title>Shop</title><style>body{font:16px/1.4 Arial;margin:0}header{background:#123;color:#fff;padding:16px}main{padding:24px}.btn{background:#06c;color:#fff;border:0;padding:12px 20px;border-radius:6px}img{display:block;width:120px;height:60px;background:#ccc}</style></head><body><header><h1>Acme Shop</h1><nav><a href="/a">Home</a> <a href="/b">Products</a></nav></header><main><p>Welcome to our store.</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Banner"><button class="btn" id="buy">Buy now</button><form><label for="e">Email</label><input id="e" type="email"></form></main></body></html>`;
const NEW = `<!doctype html><html lang="en"><head><title>Shop</title><style>body{font:16px/1.4 Arial;margin:0}header{background:#123;color:#fff;padding:16px}main{padding:40px}.btn{background:#2a2;color:#fff;border:0;padding:12px 20px;border-radius:0}img{display:block;width:120px;height:60px;background:#ccc}</style></head><body><header><h1>Acme Shop</h1><nav><a href="/a">Home</a></nav></header><main><p>Welcome to our store.</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><button class="btn" id="buy">Buy now</button><form><input id="e" type="email" placeholder="Email"></form></main></body></html>`;

async function capture(browser, html, vp) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });
  const png = await page.screenshot({ fullPage: true, animations: "disabled", caret: "initial" });
  const aria = await page.locator("body").ariaSnapshot();
  const facts = await page.evaluate(() => [...document.querySelectorAll("body *")].map((el, i) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    const path = (() => { const p = []; let n = el; while (n && n.nodeType === 1 && n !== document.body) { p.unshift(n.tagName.toLowerCase() + (n.id ? "#" + n.id : "")); n = n.parentElement; } return p.join(">"); })();
    return { path, text: (el.childElementCount ? "" : el.textContent || "").trim().slice(0, 40), box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], style: { color: cs.color, bg: cs.backgroundColor, fs: cs.fontSize, br: cs.borderRadius, pad: cs.padding } };
  }));
  const axe = await new AxeBuilder({ page }).analyze();
  await ctx.close();
  return { png, aria, facts, axe: axe.violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, sel: v.nodes[0]?.target?.join(" ") })) };
}
const t0 = Date.now();
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || chromium.executablePath(), args: ["--no-sandbox", "--headless=new"] });
const report = [];
for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  const [a, b] = [await capture(browser, REF, vp), await capture(browser, NEW, vp)];
  const A = PNG.sync.read(a.png), B = PNG.sync.read(b.png);
  const w = Math.max(A.width, B.width), h = Math.max(A.height, B.height);
  const pad = (P) => { const o = new PNG({ width: w, height: h }); o.data.fill(255); PNG.bitblt(P, o, 0, 0, P.width, P.height, 0, 0); return o; };
  const A2 = pad(A), B2 = pad(B), D = new PNG({ width: w, height: h });
  const n = pixelmatch(A2.data, B2.data, D.data, w, h, { threshold: 0.1 });
  const ls = await looksSame(PNG.sync.write(A2), PNG.sync.write(B2), { shouldCluster: true, clustersSize: 20 });
  // DOM fact diff by path
  const ma = new Map(a.facts.map(f => [f.path + "|" + f.text, f])); const dom = [];
  for (const f of b.facts) { const r = ma.get(f.path + "|" + f.text); if (!r) { dom.push({ kind: "added-or-moved", path: f.path }); continue; } for (const k of Object.keys(f.style)) if (f.style[k] !== r.style[k]) dom.push({ kind: "style:" + k, path: f.path, ref: r.style[k], got: f.style[k] }); if (f.box.join() !== r.box.join()) dom.push({ kind: "box", path: f.path, ref: r.box, got: f.box }); }
  for (const f of a.facts) if (!b.facts.some(x => x.path === f.path && x.text === f.text)) dom.push({ kind: "missing", path: f.path });
  const refIds = new Set(a.axe.map(v => v.id)); const newA11y = b.axe.filter(v => !refIds.has(v.id));
  fs.writeFileSync(`diff_${vp.width}.png`, PNG.sync.write(D));
  report.push({ viewport: vp.width, pixelsDiff: n, ratio: +(n / (w * h)).toFixed(4), clusters: (ls.diffClusters || []).length, ariaSame: a.aria === b.aria, ariaRef: a.aria.split("\n").length, domDiffs: dom.length, domSample: dom.slice(0, 4), newA11yViolations: newA11y });
}
await browser.close();
console.log(JSON.stringify({ ms: Date.now() - t0, report }, null, 1));
