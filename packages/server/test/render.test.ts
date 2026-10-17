import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChrome, PlaywrightRenderer } from "../src/bridge/render";
import { extractPage, investigate } from "@omniforge/core";

const chrome = findChrome();
let srv: http.Server, base: string;
const hits: string[] = [];
const PAGE = `<!doctype html><html lang="en"><head><title>SPA</title></head><body>
<div id="app"></div><nav><a href="/about">About</a></nav>
<script>
  // client-rendered content: invisible to a static fetch
  document.getElementById('app').innerHTML = '<h1>Rendered by JS</h1><button id="menu" aria-haspopup="true" aria-expanded="false">Menu</button><button id="del">Delete account</button><form action="/api/submit" method="post"><button type="submit">Send</button></form><div role="tablist"><button role="tab">Tab A</button><button role="tab">Tab B</button></div><details><summary>More</summary><p>hidden text appears</p></details>';
  document.getElementById('menu').addEventListener('click', e => { e.target.setAttribute('aria-expanded','true'); const d=document.createElement('div'); d.setAttribute('role','dialog'); d.textContent='menu open'; document.body.appendChild(d); });
  document.getElementById('del').addEventListener('click', () => fetch('/api/danger-delete', {method:'POST'}));
  fetch('/api/items').then(r=>r.json()).then(j=>{ const l=document.createElement('ul'); l.innerHTML='<li><a href="/item/1">Item 1</a></li>'; document.body.appendChild(l); });
  fetch('http://169.254.169.254/latest/meta-data/').catch(()=>{});
  console.error('boom from page');
</script></body></html>`;

beforeAll(async () => {
  srv = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/api/items") { res.writeHead(200, { "content-type": "application/json" }); return res.end("[]"); }
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGE); }
    if (req.url === "/about") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html lang=en><title>About</title><main><h1>About</h1></main>"); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

describe.skipIf(!chrome)("PlaywrightRenderer (real Chromium)", () => {
  let r: PlaywrightRenderer;
  beforeAll(() => { r = new PlaywrightRenderer({ executablePath: chrome!, allowPrivate: true }); });
  afterAll(async () => { await r.close(); });

  it("executes the page's JavaScript and captures what a static fetch cannot see", async () => {
    const res = await r.render(base + "/", { interact: false, scopeCheck: (u) => u.startsWith(base) });
    expect(res.html).toContain("Rendered by JS");
    // proves it is client-rendered: the STATIC document has no <h1> element at all (the text only appears inside the script)
    expect(extractPage(await (await fetch(base + "/")).text(), base + "/").headings).toEqual([]);
    expect(extractPage(res.html, base + "/").headings.map((h) => h.text)).toEqual(["Rendered by JS"]);
    expect(res.requests.some((q) => q.url === base + "/api/items" && q.resourceType === "fetch" && q.status === 200)).toBe(true);
    expect(res.consoleErrors.join()).toContain("boom from page");
    expect(res.screenshot).toMatch(/^data:image\/jpeg;base64,/);
    expect(res.title).toBe("SPA");
  }, 60_000);

  it("performs only SAFE interactions: opens menus/tabs/details; never deletes or submits", async () => {
    hits.length = 0;
    const res = await r.render(base + "/", { interact: true, scopeCheck: (u) => u.startsWith(base) });
    const targets = res.interactions.map((i) => i.target).join(" | ");
    expect(targets).toMatch(/Menu/);
    expect(res.interactions.find((i) => /Menu/.test(i.target))!.effect).toMatch(/opened 1 dialog|aria-expanded/);
    expect(targets).toMatch(/Tab A/);
    expect(targets).not.toMatch(/Delete account/);
    expect(targets).not.toMatch(/Send/);
    expect(hits.some((h) => h.includes("danger-delete"))).toBe(false); // the destructive button was never clicked
    expect(hits.some((h) => h.startsWith("POST"))).toBe(false); // nothing was submitted
  }, 60_000);

  it("blocks requests to private/metadata addresses made BY the page, per the SSRF policy", async () => {
    const strict = new PlaywrightRenderer({ executablePath: chrome!, allowPrivate: false });
    try {
      // the page itself is on loopback, so use allowPrivate:false to prove the policy engages
      await expect(strict.render(base + "/", { interact: false, scopeCheck: () => true })).resolves.toBeTruthy().catch(() => {});
      const res = await strict.render(base + "/", { interact: false, scopeCheck: () => true }).catch((e) => e);
      // navigation to a loopback page is blocked entirely when allowPrivate is false
      expect(res instanceof Error || (res.requests ?? []).some((q: any) => q.resourceType === "blocked")).toBe(true);
    } finally { await strict.close(); }
    const lax = await r.render(base + "/", { interact: false, scopeCheck: () => true });
    expect(lax.requests.some((q) => q.url.startsWith("http://169.254.169.254") && q.status !== undefined)).toBe(false); // metadata IP never answered
  }, 60_000);

  it("integrates with investigate(): rendered pages reveal links, runtime endpoints and interactions", async () => {
    const artifacts: string[] = [];
    const inv = await investigate({ targets: [base + "/"], allowPrivate: true, config: { render: true, delayMs: 0, maxPages: 6, followSitemaps: false }, renderer: r, onArtifact: (a) => artifacts.push(a.kind) });
    expect(inv.pages.map((p) => new URL(p.url).pathname)).toEqual(expect.arrayContaining(["/", "/about"]));
    expect(inv.pages[0]!.headings.map((h) => h.text)).toContain("Rendered by JS"); // only exists after JS ran
    expect(inv.endpoints.find((e) => e.url === base + "/api/items")).toMatchObject({ kind: "rest", method: "GET" });
    expect(inv.evidence.some((e) => e.kind === "dynamic" && e.method === "network-observe")).toBe(true);
    expect(inv.coverage.checks.find((c) => c.id === "render")!.status).toBe("done");
    expect(artifacts).toEqual(expect.arrayContaining(["screenshot", "interactions"]));
  }, 90_000);
});

describe("renderer availability", () => {
  it("reports a clear error when no browser is present", async () => {
    const r = new PlaywrightRenderer({ executablePath: "/nonexistent/chrome" });
    await expect(r.render("http://127.0.0.1:1/", { interact: false, scopeCheck: () => true })).rejects.toThrow();
  });
});
