// Controlled multi-page test site. Every page, asset and quirk here is deliberate,
// so tests can assert EXACTLY what a correct crawler must (and must not) find.
import http from "node:http";
import fs from "node:fs";

const page = (title, body, extraHead = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${title} page">
<link rel="stylesheet" href="/static/app.css"><link rel="manifest" href="/manifest.webmanifest">${extraHead}
<script src="/static/app.js" defer></script></head><body>
<header><nav aria-label="Main"><a href="/">Home</a> <a href="/about">About</a> <a href="/products">Products</a> <a href="/login">Login</a> <a href="/contact">Contact</a></nav></header>
<main><h1>${title}</h1>${body}</main><footer><a href="/privacy">Privacy</a></footer></body></html>`;

export const PAGES = {
  "/": page("Home", `<p>Welcome</p><form action="/search" method="get" role="search"><input type="search" name="q" placeholder="Search products"><button>Go</button></form><img src="/static/logo.svg" alt="logo"><a href="/docs/getting-started">Docs</a><a href="https://external.example/offsite">External</a>`),
  "/about": page("About", `<p>About us</p><a href="/about/team">Team</a><img src="/static/team.png">`),
  "/about/team": page("Team", `<p>The team</p><a href="/">Home</a>`),
  "/products": page("Products", `<table><tr><td>Widget</td></tr></table><a href="/products/widget">Widget</a><a href="/products/gadget">Gadget</a><a href="/redirect-me">Moved</a>`),
  "/products/widget": page("Widget", `<p>A widget</p>`),
  "/products/gadget": page("Gadget", `<p>A gadget</p><dialog id="d"><p>Hi</p></dialog>`),
  "/login": page("Login", `<form action="/api/login" method="post"><label for="e">Email</label><input id="e" name="email" type="email" required><label for="p">Password</label><input id="p" name="password" type="password" required><button>Sign in</button></form>`),
  "/contact": page("Contact", `<form action="/api/contact" method="post"><input name="name" placeholder="Name"><textarea name="msg" aria-label="Message"></textarea><input type="file" name="attachment" aria-label="File"><button>Send</button></form>`),
  // Not linked from anywhere: only reached when a test targets it. Loads real, unmodified library files so version detection is tested on genuine bytes.
  "/legacy": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Legacy</title></head><body><h1>Legacy</h1><script src="/static/vendor/jquery-1.12.4.min.js"></script><script src="/static/vendor/site-bundle.js"></script></body></html>`,
  "/privacy": page("Privacy", `<p>Privacy</p>`),
  "/docs/getting-started": page("Getting started", `<p>Docs</p><a href="/docs/getting-started">self</a>`),
  "/sitemap-only": page("Sitemap only", `<p>Only reachable via sitemap.xml</p>`),
  "/settings": page("Settings", `<p>Route referenced only inside the JS bundle</p>`),
  "/admin/secret": page("Secret admin", `<p>robots.txt disallows this</p>`),
};

const JS = `import React from "react";
const routes = [{ path: "/settings" }, { path: "/dashboard/missing" }];
export function App(){ return React.createElement("div", { onClick: () => fetch("/api/items", { method: "POST" }) }); }
fetch("/api/users");
const ws = new WebSocket("wss://rt.fixture.test/socket");
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {};
navigator.serviceWorker.register("/sw.js");
//# sourceMappingURL=app.js.map`;

const MAP = JSON.stringify({
  version: 3, file: "app.js",
  sources: ["webpack://fixture/./src/App.tsx", "webpack://fixture/./src/api.ts", "webpack://fixture/./node_modules/react/index.js"],
  sourcesContent: ["export function App(){ return null }\n", "export const api = (p: string) => fetch(p);\n", "module.exports = {};"],
});

const CSS = `:root{--brand:#3366ff;--r:8px}body{font-family:Inter,sans-serif;color:#111}@media (prefers-color-scheme: dark){body{background:#000}}@font-face{font-family:Inter;src:url(/static/inter.woff2)}.hero{background:url(/static/hero.png)}`;

export function createFixture() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    hits.push(url.pathname);
    const send = (status, type, body, headers = {}) => { res.writeHead(status, { "content-type": type, ...headers }); res.end(body); };
    const origin = `http://${req.headers.host}`;
    if (url.pathname === "/robots.txt") return send(200, "text/plain", `User-agent: *\nDisallow: /admin\nSitemap: ${origin}/sitemap.xml\n`);
    if (url.pathname === "/sitemap.xml") return send(200, "application/xml", `<?xml version="1.0"?><urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/sitemap-only</loc></url><url><loc>${origin}/admin/secret</loc></url></urlset>`);
    if (url.pathname === "/redirect-me") return send(302, "text/plain", "", { location: "/products/widget" });
    if (url.pathname === "/redirect-offsite") return send(302, "text/plain", "", { location: "http://169.254.169.254/latest/meta-data/" });
    if (url.pathname === "/static/app.js") return send(200, "application/javascript", JS, { "cache-control": "max-age=3600" });
    if (url.pathname.startsWith("/static/vendor/")) { const f = url.pathname.split("/").pop(); const real = { "jquery-1.12.4.min.js": "packages/core/test/fixtures/retire/jquery-1.12.4.min.js" }[f]; return real ? send(200, "application/javascript", fs.readFileSync(new URL("../" + real, import.meta.url))) : send(200, "application/javascript", "window.siteBundle = function(){ return 1; };"); }
    if (url.pathname === "/static/app.js.map") return send(200, "application/json", MAP);
    if (url.pathname === "/static/app.css") return send(200, "text/css", CSS);
    if (url.pathname === "/static/logo.svg") return send(200, "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'/>", { "content-length": "39" });
    if (url.pathname === "/static/team.png") return send(200, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    if (url.pathname === "/static/inter.woff2") return send(200, "font/woff2", Buffer.alloc(10));
    if (url.pathname === "/static/hero.png") return send(200, "image/png", Buffer.alloc(10));
    if (url.pathname === "/manifest.webmanifest") return send(200, "application/manifest+json", JSON.stringify({ name: "Fixture App", display: "standalone", start_url: "/", icons: [{ src: "/static/logo.svg" }] }));
    if (url.pathname === "/sw.js") return send(200, "application/javascript", "self.addEventListener('install',()=>{});");
    const p = PAGES[url.pathname];
    if (p) return send(200, "text/html; charset=utf-8", p, { "x-powered-by": "Express", "set-cookie": ["sid=abc123; HttpOnly", "pref=dark; Secure; SameSite=Lax"] });
    return send(404, "text/html", "<h1>Not found</h1>");
  });
  return {
    server, hits,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = createFixture();
  const port = Number(process.env.PORT || 4010);
  f.server.listen(port, "127.0.0.1", () => console.log(`fixture on http://127.0.0.1:${port}`));
}
