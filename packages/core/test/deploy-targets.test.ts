/**
 * Netlify + Cloudflare Pages deploy clients against a mock `fetch` that records every request.
 * The vendor APIs are not reachable from CI, so these assert the exact wire protocol (method, path, headers, body shape)
 * as documented (Netlify) / as wrangler 4.151.1 sends it (Cloudflare Pages Direct Upload).
 */
import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import * as nl from "../src/integrations/netlify";
import * as cf from "../src/integrations/cloudflare";
import { ProviderError } from "../src/ai/types";

type Req = { method: string; url: URL; headers: Record<string, string>; body: Uint8Array | undefined; text: string };
type Handler = (r: Req) => { status?: number; json?: unknown; text?: string } | undefined;

function mockFetch(handler: Handler) {
  const calls: Req[] = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {}; new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = init.body === undefined || init.body === null ? undefined : typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body instanceof Uint8Array ? init.body : (() => { throw new Error(`unexpected body type ${Object.prototype.toString.call(init.body)}`); })();
    const req: Req = { method: init.method ?? "GET", url, headers, body, text: body ? new TextDecoder().decode(body) : "" };
    calls.push(req);
    const r = handler(req) ?? { status: 404, json: { message: `no mock for ${req.method} ${url.pathname}` } };
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}
const noSleep = async () => {};
const p = (r: Req) => `${r.method} ${r.url.pathname}`;

/* ============================== Netlify ============================== */

describe("Netlify", () => {
  const files = [{ path: "index.html", data: "<h1>hi</h1>" }, { path: "./assets/app.js", data: "console.log(1)" }, { path: "img/logo.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]) }];

  function netlifyApi(o: { sites?: any[]; states?: string[]; ready?: Record<string, unknown>; status401?: boolean } = {}) {
    const states = [...(o.states ?? ["processing", "ready"])];
    return mockFetch((r) => {
      if (o.status401) return { status: 401, json: { code: 401, message: "Access Denied: Invalid token" } };
      if (p(r) === "GET /api/v1/sites") return { json: o.sites ?? [] };
      if (p(r) === "GET /api/v1/sites/site_given") return { json: { id: "site_given", name: "given", ssl_url: "https://given.netlify.app" } };
      if (p(r) === "POST /api/v1/sites") return { status: 201, json: { id: "site_new", name: JSON.parse(r.text).name, ssl_url: "https://whatever.netlify.app" } };
      if (r.method === "POST" && /^\/api\/v1\/sites\/[^/]+\/deploys$/.test(r.url.pathname)) return { json: { id: "dep_1", site_id: "site_new", state: "uploaded" } };
      if (p(r) === "GET /api/v1/deploys/dep_1") {
        const s = states.shift() ?? "ready";
        return { json: { id: "dep_1", site_id: "site_new", state: s, ...(s === "ready" ? (o.ready ?? { ssl_url: "https://api-reported.example.org", deploy_ssl_url: "https://dep_1--api-reported.netlify.app" }) : {}), ...(s === "error" ? { error_message: "Deploy directory 'dist' does not exist" } : {}) } };
      }
      return undefined;
    });
  }

  it("creates the site when none matches exactly, uploads a ZIP of the files, polls, and returns the URLs the API reported", async () => {
    const api = netlifyApi({ sites: [{ id: "other", name: "my-site-old" }] }); // substring match from the API must NOT be reused
    const seen: string[] = [];
    const r = await nl.deploySite({ token: "nl-tok", fetch: api.f, sleep: noSleep }, files, { name: "My Site!" }, (s) => seen.push(s));
    expect(api.calls.map(p)).toEqual(["GET /api/v1/sites", "POST /api/v1/sites", "POST /api/v1/sites/site_new/deploys", "GET /api/v1/deploys/dep_1", "GET /api/v1/deploys/dep_1"]);
    expect(api.calls[0]!.url.searchParams.get("name")).toBe("my-site");
    expect(api.calls[0]!.url.searchParams.get("filter")).toBe("all");
    expect(api.calls[1]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(api.calls[1]!.text)).toEqual({ name: "my-site" });
    const up = api.calls[2]!;
    expect(up.url.origin).toBe("https://api.netlify.com");
    expect(up.headers["content-type"]).toBe("application/zip");
    const zip = unzipSync(up.body!);
    expect(Object.keys(zip).sort()).toEqual(["assets/app.js", "img/logo.png", "index.html"]);
    expect(strFromU8(zip["index.html"]!)).toBe("<h1>hi</h1>");
    expect(Array.from(zip["img/logo.png"]!)).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 255]); // binary survives exactly
    expect(api.calls.every((c) => c.headers.authorization === "Bearer nl-tok")).toBe(true);
    // the URL comes from the API response — it is deliberately not derivable from the site name here
    expect(r.deploy).toMatchObject({ id: "dep_1", state: "ready", url: "https://api-reported.example.org", deployUrl: "https://dep_1--api-reported.netlify.app" });
    expect(r.site).toMatchObject({ id: "site_new", created: true });
    expect(seen).toEqual(["site created", "uploaded", "processing", "ready"]);
  });

  it("reuses an existing site with the exact name, or the given site id — no new site is created", async () => {
    const a = netlifyApi({ sites: [{ id: "site_mine", name: "my-site" }] });
    await nl.deploySite({ token: "t", fetch: a.f, sleep: noSleep }, files, { name: "my-site" });
    expect(a.calls.map(p)).not.toContain("POST /api/v1/sites");
    expect(a.calls.map(p)).toContain("POST /api/v1/sites/site_mine/deploys");
    const b = netlifyApi();
    await nl.deploySite({ token: "t", fetch: b.f, sleep: noSleep }, files, { name: "ignored", siteId: "site_given" });
    expect(b.calls.map(p).slice(0, 2)).toEqual(["GET /api/v1/sites/site_given", "POST /api/v1/sites/site_given/deploys"]);
  });

  it("a 401 is an actionable ProviderError that does not echo the token, and nothing is uploaded", async () => {
    const api = netlifyApi({ status401: true });
    const e = await nl.deploySite({ token: "secret-token-value", fetch: api.f, sleep: noSleep }, files, { name: "x" }).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.status).toBe(401);
    expect(e.message).toMatch(/401.*Invalid token.*token invalid or expired/);
    expect(e.message).not.toContain("secret-token-value");
    expect(api.calls).toHaveLength(1);
    await expect(nl.whoami({ token: "x", fetch: api.f })).rejects.toThrow(/401/);
  });

  it("a failed deploy is reported as state 'error' with Netlify's message — never as ready", async () => {
    const api = netlifyApi({ states: ["processing", "error"] });
    const r = await nl.deploySite({ token: "t", fetch: api.f, sleep: noSleep }, files, { name: "x" });
    expect(r.deploy.state).toBe("error");
    expect(r.deploy.errorMessage).toMatch(/does not exist/);
  });

  it("a 'ready' response without any URL is an error, not a guessed <name>.netlify.app", async () => {
    const api = netlifyApi({ states: ["ready"], ready: {} });
    await expect(nl.deploySite({ token: "t", fetch: api.f, sleep: noSleep }, files, { name: "x" })).rejects.toThrow(/no URL/);
  });

  it("times out instead of polling forever", async () => {
    const api = netlifyApi({ states: Array(1000).fill("processing") });
    let t = 0;
    await expect(nl.waitForDeploy({ token: "t", fetch: api.f, sleep: noSleep, now: () => (t += 60_000), timeoutMs: 300_000 }, "dep_1")).rejects.toThrow(/Timed out/);
    expect(api.calls.length).toBeLessThan(10);
  });

  it("refuses paths that escape the site directory, duplicates and empty uploads", () => {
    expect(() => nl.zipSite([{ path: "../etc/passwd", data: "x" }])).toThrow(/leaves the site directory/);
    expect(() => nl.zipSite([{ path: "a.html", data: "x" }, { path: "./a.html", data: "y" }])).toThrow(/Duplicate/);
    expect(() => nl.zipSite([])).toThrow(/no files/);
    expect(nl.siteName("My Cool App!!")).toBe("my-cool-app");
  });

  it("whoami reads the current user", async () => {
    const api = mockFetch((r) => (p(r) === "GET /api/v1/user" ? { json: { email: "a@b.c", full_name: "A B" } } : undefined));
    expect(await nl.whoami({ token: "t", fetch: api.f })).toEqual({ email: "a@b.c", name: "A B" });
  });
});

/* ========================== Cloudflare Pages ========================== */

describe("Cloudflare Pages hashing (wrangler's scheme)", () => {
  // Expected values computed with blake3-wasm 2.1.5 — the library wrangler 4.151.1 uses — via
  // blake3.hash(contents.toString("base64") + path.extname(p).substring(1)).toString("hex").slice(0, 32)
  const vectors: [string, Uint8Array | string, string][] = [
    ["index.html", "<h1>hi</h1>", "e5e943f01929441dfbb0d4956a759fda"],
    ["a/b.bin", new Uint8Array([1, 2, 3]), "c30f33b3677dab10cc8c4def907dc4b4"],
    ["noext", "plain", "e02f9a01f7c51f4dd16d117956854e03"],
    ["empty.css", "", "9e7a27539226d700e116522ee435029d"],
    ["big.js", new Uint8Array(5000).fill(7), "f492e40ea4f1837e188939d5d1a614f4"],
    ["assets/app.min.JS", "x", "70240ce2fdc43ec2e12862b7ba7bf9ca"],
    [".well-known/security.txt", "Contact: x", "bd863beb228521ae5d6d6f3aedbe4d92"],
    [".htaccess", "x", "c89c27f28e24f706b72c408fe1d6537a"],
    ["file.", "x", "c89c27f28e24f706b72c408fe1d6537a"],
    ["dir.v2/readme", "x", "c89c27f28e24f706b72c408fe1d6537a"],
  ];
  it.each(vectors)("%s", (path, data, expected) => expect(cf.hashAsset(path, data)).toBe(expected));
  it("extension and content-type rules match path.extname / mime", () => {
    expect([cf.extOf("a/b.tar.gz"), cf.extOf(".env"), cf.extOf("x."), cf.extOf("d.d/x")]).toEqual(["gz", "", "", ""]);
    expect([cf.contentTypeOf("a.html"), cf.contentTypeOf("a.JS"), cf.contentTypeOf("f.ico"), cf.contentTypeOf("x.unknownext"), cf.contentTypeOf("README")]).toEqual(["text/html", "application/javascript", "image/vnd.microsoft.icon", "application/octet-stream", "application/octet-stream"]);
  });
});

describe("Cloudflare Pages Direct Upload", () => {
  const ACCT = "acc123";
  const files = [{ path: "index.html", data: "<h1>hi</h1>" }, { path: "a/b.bin", data: new Uint8Array([1, 2, 3]) }, { path: "style.css", data: "body{}" }, { path: "_headers", data: "/*\n  X-Frame-Options: DENY\n" }, { path: "node_modules/x/index.js", data: "skip" }, { path: ".DS_Store", data: "skip" }];
  const H_INDEX = "e5e943f01929441dfbb0d4956a759fda", H_BIN = "c30f33b3677dab10cc8c4def907dc4b4";

  function cfApi(o: { project?: boolean; status401?: boolean; stages?: { name: string; status: string }[]; missing?: string[]; upsertFails?: boolean; finalUrl?: string | null } = {}) {
    const stages = [...(o.stages ?? [{ name: "queued", status: "active" }, { name: "deploy", status: "active" }, { name: "deploy", status: "success" }])];
    const ok = (result: unknown, status = 200) => ({ status, json: { success: true, errors: [], messages: [], result } });
    const projBase = `/client/v4/accounts/${ACCT}/pages/projects/my-site`;
    return mockFetch((r) => {
      if (o.status401) return { status: 401, json: { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null } };
      const path = r.url.pathname;
      if (p(r) === `GET ${projBase}`) return o.project ? ok({ name: "my-site", subdomain: "my-site-1x2.pages.dev", production_branch: "main" }) : { status: 404, json: { success: false, errors: [{ code: 8000007, message: "Project not found." }], result: null } };
      if (p(r) === `POST /client/v4/accounts/${ACCT}/pages/projects`) return ok({ name: "my-site", subdomain: "my-site-1x2.pages.dev", production_branch: "main" });
      if (p(r) === `GET ${projBase}/upload-token`) return ok({ jwt: "jwt-abc" });
      if (p(r) === "POST /client/v4/pages/assets/check-missing") return ok(o.missing ?? JSON.parse(r.text).hashes);
      if (p(r) === "POST /client/v4/pages/assets/upload") return ok({ successful_key_count: JSON.parse(r.text).length });
      if (p(r) === "POST /client/v4/pages/assets/upsert-hashes") return o.upsertFails ? { status: 500, json: { success: false, errors: [{ code: 8000000, message: "boom" }] } } : ok(null);
      if (p(r) === `POST ${projBase}/deployments`) return ok({ id: "d-1", url: "https://d1abc.my-site-1x2.pages.dev", latest_stage: { name: "queued", status: "active" }, aliases: null, environment: "production" });
      if (p(r) === `GET ${projBase}/deployments/d-1`) { const s = stages.shift() ?? { name: "deploy", status: "success" }; return ok({ id: "d-1", url: o.finalUrl === null ? null : (o.finalUrl ?? "https://d1abc.my-site-1x2.pages.dev"), latest_stage: s, aliases: o.finalUrl === null ? [] : ["https://my-site-1x2.pages.dev"], environment: "production" }); }
      if (r.method === "GET" && path === `${projBase}/deployments/d-1/history/logs`) return ok({ total: 2, data: [{ line: "Initializing" }, { line: "Error: Asset upload incomplete" }] });
      return undefined;
    });
  }
  const O = (f: typeof fetch, extra: Partial<cf.CfOptions> = {}): cf.CfOptions => ({ token: "cf-tok", accountId: ACCT, fetch: f, sleep: noSleep, ...extra });

  it("runs wrangler's sequence: project (created on 8000007) → upload token → check-missing → upload missing → upsert → multipart deployment → poll", async () => {
    const api = cfApi({ missing: [H_BIN] }); // index.html/style.css already on Cloudflare: only b.bin is uploaded
    const seen: string[] = [];
    const r = await cf.deploySite(O(api.f), files, { name: "My Site" }, (s) => seen.push(s));
    expect(api.calls.map(p)).toEqual([
      `GET /client/v4/accounts/${ACCT}/pages/projects/my-site`,
      `POST /client/v4/accounts/${ACCT}/pages/projects`,
      `GET /client/v4/accounts/${ACCT}/pages/projects/my-site/upload-token`,
      "POST /client/v4/pages/assets/check-missing",
      "POST /client/v4/pages/assets/upload",
      "POST /client/v4/pages/assets/upsert-hashes",
      `POST /client/v4/accounts/${ACCT}/pages/projects/my-site/deployments`,
      `GET /client/v4/accounts/${ACCT}/pages/projects/my-site/deployments/d-1`,
      `GET /client/v4/accounts/${ACCT}/pages/projects/my-site/deployments/d-1`,
      `GET /client/v4/accounts/${ACCT}/pages/projects/my-site/deployments/d-1`,
    ]);
    expect(api.calls.every((c) => c.url.origin === "https://api.cloudflare.com")).toBe(true);
    expect(JSON.parse(api.calls[1]!.text)).toEqual({ name: "my-site", production_branch: "main" });
    // account endpoints use the API token; asset endpoints use the upload JWT
    const auth = api.calls.map((c) => c.headers.authorization);
    expect(auth).toEqual(["Bearer cf-tok", "Bearer cf-tok", "Bearer cf-tok", "Bearer jwt-abc", "Bearer jwt-abc", "Bearer jwt-abc", "Bearer cf-tok", "Bearer cf-tok", "Bearer cf-tok", "Bearer cf-tok"]);
    const hashes = JSON.parse(api.calls[3]!.text).hashes;
    expect(hashes).toHaveLength(3); // _headers, node_modules and .DS_Store are not assets
    expect(hashes).toEqual(expect.arrayContaining([H_INDEX, H_BIN, cf.hashAsset("style.css", "body{}")]));
    expect(api.calls[3]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(api.calls[4]!.text)).toEqual([{ key: H_BIN, value: btoa("\x01\x02\x03"), metadata: { contentType: "application/octet-stream" }, base64: true }]);
    expect(JSON.parse(api.calls[5]!.text)).toEqual({ hashes });
    // the deployment is real multipart/form-data: parse it back with the platform's own parser
    const dep = api.calls[6]!;
    expect(dep.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const form = await new Response(dep.body, { headers: { "content-type": dep.headers["content-type"]! } }).formData();
    expect(JSON.parse(String(form.get("manifest")))).toEqual({ "/index.html": H_INDEX, "/a/b.bin": H_BIN, "/style.css": cf.hashAsset("style.css", "body{}") });
    expect(form.has("branch")).toBe(false); // no branch → production, as wrangler does outside a git repo
    const hdr = form.get("_headers") as File;
    expect(hdr.name).toBe("_headers");
    expect(await hdr.text()).toBe("/*\n  X-Frame-Options: DENY\n");
    // URL from the response, not composed from the project name
    expect(r.deployment).toMatchObject({ id: "d-1", url: "https://d1abc.my-site-1x2.pages.dev", alias: "https://my-site-1x2.pages.dev", stage: "deploy", status: "success" });
    expect(r.upload).toMatchObject({ uploaded: 1, skipped: 2 });
    expect(r.project).toMatchObject({ name: "my-site", created: true });
    expect(seen).toContain("project created");
    expect(seen.at(-1)).toBe("deploy: success");
  });

  it("uses an existing project, sends a branch for previews, and splits uploads into size-bounded requests", async () => {
    const api = cfApi({ project: true });
    await cf.deploySite(O(api.f, { bucketBytes: 8 }), files, { name: "my-site", branch: "preview" });
    expect(api.calls.map(p)).not.toContain(`POST /client/v4/accounts/${ACCT}/pages/projects`);
    const uploads = api.calls.filter((c) => p(c) === "POST /client/v4/pages/assets/upload").map((c) => JSON.parse(c.text).map((x: any) => x.key));
    expect(uploads.length).toBeGreaterThan(1);
    expect(uploads.flat().sort()).toEqual(JSON.parse(api.calls.find((c) => c.url.pathname.endsWith("check-missing"))!.text).hashes.sort());
    const dep = api.calls.find((c) => c.url.pathname.endsWith("/deployments") && c.method === "POST")!;
    const form = await new Response(dep.body, { headers: { "content-type": dep.headers["content-type"]! } }).formData();
    expect(form.get("branch")).toBe("preview");
  });

  it("a 401 stops at the first request with an actionable error (token not echoed)", async () => {
    const api = cfApi({ status401: true });
    const e = await cf.deploySite(O(api.f, { token: "very-secret-cf-token" }), files, { name: "my-site" }).catch((x) => x);
    expect(e).toBeInstanceOf(cf.CloudflareError);
    expect(e.status).toBe(401);
    expect(e.message).toMatch(/401: Authentication error \[10000\].*token invalid or expired/);
    expect(e.message).not.toContain("very-secret-cf-token");
    expect(api.calls).toHaveLength(1);
    await expect(cf.listProjects(O(api.f))).rejects.toThrow(/401/);
  });

  it("a failed stage is returned as a failure with the last log line — never as success", async () => {
    const api = cfApi({ project: true, stages: [{ name: "deploy", status: "active" }, { name: "deploy", status: "failure" }] });
    const r = await cf.deploySite(O(api.f), files, { name: "my-site" });
    expect(r.deployment.status).toBe("failure");
    expect(r.deployment.errorMessage).toBe("Asset upload incomplete");
  });

  it("a finished deployment without any URL is an error, not a guessed <name>.pages.dev", async () => {
    const api = cfApi({ project: true, finalUrl: null });
    await expect(cf.waitForDeployment(O(api.f), "my-site", "d-1")).rejects.toThrow(/no URL/);
  });

  it("times out instead of polling forever", async () => {
    const api = cfApi({ project: true, stages: Array(1000).fill({ name: "deploy", status: "active" }) });
    let t = 0;
    await expect(cf.waitForDeployment(O(api.f, { now: () => (t += 60_000), timeoutMs: 300_000 }), "my-site", "d-1")).rejects.toThrow(/Timed out/);
  });

  it("an upsert-hashes failure is a warning (as in wrangler), the deployment still proceeds", async () => {
    const api = cfApi({ project: true, upsertFails: true });
    const r = await cf.deploySite(O(api.f), files, { name: "my-site" });
    expect(r.upload.upsertWarning).toMatch(/asset cache/);
    expect(r.deployment.status).toBe("success");
  });

  it("refuses Pages Functions / _worker.js and oversized files BEFORE any request", async () => {
    const api = cfApi();
    await expect(cf.deploySite(O(api.f), [...files, { path: "_worker.js", data: "export default {}" }], { name: "my-site" })).rejects.toThrow(/not supported here/);
    await expect(cf.deploySite(O(api.f), [...files, { path: "functions/api.ts", data: "x" }], { name: "my-site" })).rejects.toThrow(/not supported here/);
    await expect(cf.deploySite(O(api.f), [{ path: "huge.bin", data: new Uint8Array(25 * 1024 * 1024 + 1) }], { name: "my-site" })).rejects.toThrow(/25 MiB/);
    await expect(cf.deploySite(O(api.f), [{ path: "_headers", data: "x" }], { name: "my-site" })).rejects.toThrow(/no static files/);
    expect(api.calls).toEqual([]);
  });

  it("multipartBody escapes field names and is parseable", async () => {
    const body = cf.multipartBody([{ name: 'a"b', value: "line1\r\nline2" }, { name: "f", value: "ü", filename: "f.txt" }], "BOUND");
    const form = await new Response(body, { headers: { "content-type": "multipart/form-data; boundary=BOUND" } }).formData();
    expect(form.get('a"b')).toBe("line1\r\nline2"); // %22 is the HTML-spec escape, decoded by the parser
    expect(await (form.get("f") as File).text()).toBe("ü");
    expect(() => cf.multipartBody([{ name: "x", value: "a--BOUND" }], "BOUND")).toThrow(/boundary/);
  });
});
