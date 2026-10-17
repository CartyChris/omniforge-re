import { describe, expect, it } from "vitest";
import { parseRobots } from "../src/crawl/robots";
import { parseSitemap } from "../src/crawl/sitemap";
import { dotenvNames, envVarNames, redactSecrets } from "../src/util/redact";
import { analyzeJs } from "../src/analyze/js";
import { fingerprint } from "../src/analyze/fingerprint";
import { extractCssUrls, extractDesignTokens, extractPage } from "../src/analyze/html";

describe("robots.txt", () => {
  const txt = `User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\nCrawl-delay: 2\nSitemap: https://x.test/sm.xml\n\nUser-agent: OmniForgeRE\nDisallow: /blocked\n`;
  it("applies the most specific group", () => {
    const r = parseRobots(txt, "OmniForgeRE/1.0");
    expect(r.allow("/blocked/x")).toBe(false);
    expect(r.allow("/private")).toBe(true); // specific group has no /private rule
  });
  it("longest match wins, wildcards and $ anchors work", () => {
    const r = parseRobots(txt, "Other/1.0");
    expect(r.allow("/private/secret")).toBe(false);
    expect(r.allow("/private/public/x")).toBe(true);
    expect(r.allow("/doc.pdf")).toBe(false);
    expect(r.allow("/doc.pdf.html")).toBe(true);
    expect(r.crawlDelay).toBe(2);
    expect(r.sitemaps).toEqual(["https://x.test/sm.xml"]);
  });
  it("empty Disallow allows everything", () => expect(parseRobots("User-agent: *\nDisallow:", "x").allow("/a")).toBe(true));
});

describe("sitemap", () => {
  it("distinguishes index from urlset", () => {
    expect(parseSitemap("<urlset><url><loc>https://a/1?a=1&amp;b=2</loc></url></urlset>").urls).toEqual(["https://a/1?a=1&b=2"]);
    expect(parseSitemap("<sitemapindex><sitemap><loc>https://a/s.xml</loc></sitemap></sitemapindex>").sitemaps).toEqual(["https://a/s.xml"]);
  });
});

describe("redaction", () => {
  it("redacts common secret shapes and reports kinds", () => {
    const AWS = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    const JWT = ["eyJhbGciOiJIUzI1", "eyJzdWIiOiIxMjM0NTY3", "SflKxwRJSMeKKF2QT4fw"].join(".");
    const t = `AWS=${AWS} gh=ghp_` + "a".repeat(36) + ` db=postgres://u:hunter2@h/db API_KEY=abcdef123456 jwt=${JWT}`;
    const r = redactSecrets(t);
    for (const leak of [AWS, "hunter2", "abcdef123456", "SflKxwRJSMeKKF2QT4fw"]) expect(r.text).not.toContain(leak);
    expect(r.found).toEqual(expect.arrayContaining(["aws-access-key", "github-token", "url-credentials", "assignment", "jwt"]));
  });
  it("extracts env var NAMES only", () => {
    expect(envVarNames("process.env.A_B; import.meta.env.VITE_X; os.environ['PY_V']; std::env::var(\"RUST_V\")").sort()).toEqual(["A_B", "PY_V", "RUST_V", "VITE_X"]);
    expect(dotenvNames("# c\nFOO=bar\nexport BAZ=1\n")).toEqual(["BAZ", "FOO"]);
    expect(envVarNames("x = 5\nFOO = 1")).toEqual([]);
  });
});

describe("analyzeJs (AST)", () => {
  it("finds imports, exports, components, endpoints, events and routes", () => {
    const code = `
      import React from "react"; import { api } from "./api.js";
      export function App(){ return React.createElement("div", { onClick: () => {} }) }
      const Card = () => React.createElement("span");
      fetch("/api/users", { method: "POST" });
      axios.get("https://api.example.com/v1/items");
      new WebSocket("wss://rt.example.com/socket");
      document.addEventListener("keydown", () => {});
      localStorage.setItem("theme", "dark");
      const routes = [{ path: "/settings" }, { path: "billing" }];
      const m = await import("./lazy.js");
      const s = process.env.API_URL;
    `;
    const r = analyzeJs(code);
    expect(r.method).toBe("ast");
    expect(r.imports).toEqual(expect.arrayContaining(["react", "./api.js"]));
    expect(r.dynamicImports).toEqual(["./lazy.js"]);
    expect(r.exports).toContain("App");
    expect(r.components).toEqual(expect.arrayContaining(["App", "Card"]));
    expect(r.endpoints.find((e) => e.url === "/api/users")!.method).toBe("POST");
    expect(r.endpoints.map((e) => e.url)).toEqual(expect.arrayContaining(["https://api.example.com/v1/items", "wss://rt.example.com/socket"]));
    expect(r.events).toEqual(expect.arrayContaining(["keydown", "click"]));
    expect(r.storageKeys).toEqual(["theme"]);
    expect(r.routes).toEqual(expect.arrayContaining(["/settings", "/billing"]));
    expect(r.envVars).toEqual(["API_URL"]);
  });
  it("falls back to lexical scanning with an honest method flag on unparsable input", () => {
    const r = analyzeJs(`import x from "pkg"; fetch("/api/z"); <<<< not js`);
    expect(r.method).toBe("lexical");
    expect(r.parseError).toBeTruthy();
    expect(r.imports).toContain("pkg");
  });
  it("captures sourceMappingURL", () => expect(analyzeJs("var a=1;\n//# sourceMappingURL=app.js.map").sourceMappingURL).toBe("app.js.map"));
});

describe("fingerprint", () => {
  const base = { url: "https://t.test/", headers: {}, html: "", scriptUrls: [], scripts: [], css: [], cssUrls: [], meta: {}, cookies: [] };
  it("reports technologies only with evidence and never invents any", () => {
    const empty = fingerprint(base);
    expect(empty.technologies).toEqual([]);
    expect(empty.evidence).toEqual([]);
  });
  it("detects Next.js (+implied React), Vercel, Tailwind with versions and linked evidence", () => {
    const r = fingerprint({
      ...base,
      headers: { "x-powered-by": "Next.js", "x-vercel-id": "iad1::abc", server: "Vercel" },
      html: `<script id="__NEXT_DATA__" type="application/json">{}</script><script src="/_next/static/chunks/main.js"></script>`,
      scriptUrls: ["https://t.test/_next/static/chunks/main.js"],
      css: [{ url: "https://t.test/a.css", content: "/*! tailwindcss v4.1.2 */ .x{--tw-ring-offset-width:0}" }],
    });
    const by = Object.fromEntries(r.technologies.map((t) => [t.name, t]));
    expect(by["Next.js"]!.confidence).toBeGreaterThan(0.99);
    expect(by["React"]).toBeTruthy();
    expect(r.evidence.find((e) => e.id === by["React"]!.evidence[0])!.kind).toBe("inferred");
    expect(by["Vercel"]).toBeTruthy();
    expect(by["Tailwind CSS"]!.version).toBe("4.1.2");
    for (const t of r.technologies) expect(t.evidence.length).toBeGreaterThan(0);
  });
  it("does not flag React for a page that merely looks like one", () => {
    const r = fingerprint({ ...base, html: "<div id='root'><h1>Hello</h1></div>" });
    expect(r.technologies.find((t) => t.name === "React")).toBeUndefined();
  });
});

describe("html extraction", () => {
  const html = `<!doctype html><html lang="en"><head><title> Demo </title><meta name="generator" content="Hugo 0.120"><link rel="stylesheet" href="/s.css"><link rel="manifest" href="/m.json"><script src="/a.js"></script></head>
  <body><nav><a href="/about">About</a><a href="https://other.test/x">Ext</a></nav><main><h1>Hi</h1><img src="/i.png"><form action="/login" method="post"><input name="email" type="email" required><input name="pw" type="password"></form><button>Go</button><dialog></dialog>
  <a href="mailto:a@b.c">m</a><a href="javascript:void(0)">j</a><a href="#top">t</a><a href="/x#frag">x</a></main></body></html>`;
  it("extracts structure and ignores non-navigational links", () => {
    const p = extractPage(html, "https://t.test/");
    expect(p.title).toBe("Demo");
    expect(p.links.sort()).toEqual(["https://other.test/x", "https://t.test/about", "https://t.test/x"]);
    expect(p.scripts).toEqual(["https://t.test/a.js"]);
    expect(p.manifest).toBe("https://t.test/m.json");
    expect(p.forms[0]).toMatchObject({ action: "https://t.test/login", method: "post" });
    expect(p.forms[0]!.fields.map((f) => f.name)).toEqual(["email", "pw"]);
    expect(p.a11y).toMatchObject({ imagesWithoutAlt: 1, inputsWithoutLabel: 2, hasLang: true, hasMain: true });
    expect(p.interactive.dialogs).toBe(1);
    expect(p.meta.generator).toBe("Hugo 0.120");
  });
  it("extracts CSS urls and design tokens", () => {
    expect(extractCssUrls("@import 'x.css'; a{background:url(/img/a.png)} @font-face{src:url('f.woff2')}", "https://t.test/css/a.css").sort()).toEqual(["https://t.test/css/f.woff2", "https://t.test/css/x.css", "https://t.test/img/a.png"]);
    const t = extractDesignTokens(":root{--brand:#ff0066;--r:8px} a{color:#ff0066;font-family:Inter,sans-serif}");
    expect(t.variables["--brand"]).toBe("#ff0066");
    expect(t.colors[0]).toEqual({ value: "#ff0066", count: 2 });
    expect(t.fonts[0]!.value).toBe("Inter");
  });
});
