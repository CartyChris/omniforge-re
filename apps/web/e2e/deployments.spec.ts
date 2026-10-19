import { expect, test, type Page } from "@playwright/test";
import { noErrors, prepare } from "./helpers";

type Call = { method: string; path: string; body: any };

/** A stateful stand-in for api.github.com (only the Git Data/PR endpoints OmniForge uses) so the whole flow runs offline. */
async function fakeGitHub(page: Page) {
  const calls: Call[] = [];
  const refs: Record<string, string> = { main: "headsha" };
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS" };
  await page.route("https://api.github.com/**", async (route) => {
    const req = route.request(); const u = new URL(req.url()); const method = req.method(); const path = u.pathname;
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = req.postData() ? JSON.parse(req.postData()!) : undefined; calls.push({ method, path, body });
    const json = (status: number, o: unknown) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(o) });
    const ref = path.match(/^\/repos\/octo\/demo\/git\/ref\/heads\/(.+)$/);
    if (method === "GET" && path === "/user") return json(200, { login: "octo", name: "Octo" });
    if (method === "GET" && path === "/user/repos") return json(200, [{ full_name: "octo/demo", private: true, default_branch: "main", html_url: "https://github.com/octo/demo" }]);
    if (method === "GET" && ref) return refs[decodeURIComponent(ref[1]!)] ? json(200, { object: { sha: refs[decodeURIComponent(ref[1]!)] } }) : json(404, { message: "Not Found" });
    if (method === "GET" && path.startsWith("/repos/octo/demo/git/commits/")) return json(200, { tree: { sha: "basetree" } });
    if (method === "POST" && path === "/repos/octo/demo/git/blobs") return json(201, { sha: `blob${calls.length}` });
    if (method === "POST" && path === "/repos/octo/demo/git/trees") return json(201, { sha: "newtree" });
    if (method === "POST" && path === "/repos/octo/demo/git/commits") return json(201, { sha: "newcommit1234", html_url: "https://github.com/octo/demo/commit/newcommit1234" });
    if (method === "POST" && path === "/repos/octo/demo/git/refs") { refs[String(body.ref).replace("refs/heads/", "")] = body.sha; return json(201, {}); }
    if (method === "POST" && path === "/repos/octo/demo/pulls") return json(201, { number: 7, html_url: "https://github.com/octo/demo/pull/7" });
    return json(404, { message: `unexpected ${method} ${path}` });
  });
  return { calls, refs };
}

test("GitHub pull request: approval first, new branch from base, base never written, PR opened and recorded", async ({ page }) => {
  const errors = await prepare(page);
  const gh = await fakeGitHub(page);
  // connect GitHub (token goes to the vault; the fake API accepts any token)
  await page.goto("/#/integrations");
  await page.getByLabel("Personal access token").fill("e2e-fake-token-not-real-0000");
  await page.getByRole("button", { name: "Verify & save" }).first().click();
  await expect(page.getByText("Connected as octo")).toBeVisible();
  // a project with a deployable file
  await page.goto("/#/workspace");
  await page.locator("input[type=file]").first().setInputFiles({ name: "index.html", mimeType: "text/html", buffer: Buffer.from("<h1>Hello</h1>") });
  await page.waitForTimeout(600);
  await page.goto("/#/deployments");
  await page.getByRole("radio", { name: "Pull request" }).click();
  await page.getByRole("button", { name: "Pick from my repositories" }).click();
  await expect(page.getByRole("combobox", { name: "Repository" })).toContainText("octo/demo");
  // an invalid branch name blocks the button
  const branch = page.getByLabel("New branch");
  await branch.fill("bad name");
  await expect(page.getByRole("button", { name: "Open pull request" })).toBeDisabled();
  await branch.fill("omniforge/e2e-change");
  await page.getByLabel("Title").fill("Add the hello page");
  const writesBefore = gh.calls.filter((c) => c.method !== "GET").length;
  await page.getByRole("button", { name: "Open pull request" }).click();
  // nothing is written until the user approves what will be published
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Open a pull request on octo/demo?");
  await expect(dialog).toContainText("omniforge/e2e-change");
  expect(gh.calls.filter((c) => c.method !== "GET").length).toBe(writesBefore);
  await dialog.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText("Pull request #7 opened", { exact: true })).toBeVisible({ timeout: 20_000 });
  // the wire protocol: branch created from base head, one commit with that parent, PR head/base correct, base ref never touched
  const commit = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/git/commits"))!;
  expect(commit.body.parents).toEqual(["headsha"]);
  expect(gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/refs")).map((c) => c.body.ref)).toEqual(["refs/heads/omniforge/e2e-change"]);
  expect(gh.calls.some((c) => c.method === "PATCH" || (c.method === "POST" && c.path.endsWith("/git/refs") && c.body.ref === "refs/heads/main"))).toBe(false);
  expect(gh.refs["main"]).toBe("headsha");
  expect(gh.calls.at(-1)).toMatchObject({ method: "POST", path: "/repos/octo/demo/pulls", body: { title: "Add the hello page", head: "omniforge/e2e-change", base: "main" } });
  // recorded in history and in the audit trail
  await expect(page.getByText(/pull request #7 opened on octo\/demo/)).toBeVisible();
  await page.goto("/#/settings");
  await page.getByRole("tab", { name: "Diagnostics" }).click();
  await expect(page.getByTestId("audit-trail")).toContainText("pull request opened");
  await expect(page.getByTestId("audit-trail")).toContainText("octo/demo#7");
  // GitHub answers 404 when probing for the (not yet existing) new branch — the browser logs that as a console error by itself.
  noErrors(errors.filter((e) => !/status of 404/.test(e)));
});

test("GitHub pull request: denying the approval writes nothing", async ({ page }) => {
  const errors = await prepare(page);
  const gh = await fakeGitHub(page);
  await page.goto("/#/integrations");
  await page.getByLabel("Personal access token").fill("e2e-fake-token-not-real-0000");
  await page.getByRole("button", { name: "Verify & save" }).first().click();
  await expect(page.getByText("Connected as octo")).toBeVisible();
  await page.goto("/#/workspace");
  await page.locator("input[type=file]").first().setInputFiles({ name: "index.html", mimeType: "text/html", buffer: Buffer.from("<h1>Hello</h1>") });
  await page.waitForTimeout(600);
  await page.goto("/#/deployments");
  await page.getByRole("radio", { name: "Pull request" }).click();
  await page.getByLabel(/Repository \(owner\/name\)/).fill("octo/demo");
  await page.getByRole("button", { name: "Open pull request" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText(/Pull request cancelled/)).toBeVisible();
  expect(gh.calls.filter((c) => c.method !== "GET" && c.path !== "/user")).toEqual([]);
  expect(gh.calls.some((c) => c.path.includes("/git/"))).toBe(false);
  noErrors(errors);
});

test("setup & diagnostics: real probes (GitHub token verified against the API), engine skipped in the web version, report downloadable", async ({ page }) => {
  const errors = await prepare(page);
  await fakeGitHub(page);
  await page.goto("/#/integrations");
  await page.getByLabel("Personal access token").fill("e2e-fake-token-not-real-0000");
  await page.getByRole("button", { name: "Verify & save" }).first().click();
  await expect(page.getByText("Connected as octo")).toBeVisible();
  await page.getByRole("button", { name: "Run checks" }).click();
  const list = page.getByTestId("health-checks");
  await expect(list).toContainText("Token works (signed in as octo)");
  await expect(list).toContainText("Web version");
  await expect(list).toContainText("No provider connected");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Save report" }).click()]);
  expect(dl.suggestedFilename()).toBe("omniforge-diagnostics.json");
  noErrors(errors);
});

/* ---------------- Netlify / Cloudflare Pages (static hosting) ---------------- */

type Fwd = { method: string; url: URL; headers: Record<string, string>; body?: string; bytes?: Buffer };

/**
 * Both vendor APIs are reached through the app's real fetch path — the hosted /api/forward envelope (they are not
 * relied on for browser CORS) — so the stub answers there, keyed on the forwarded URL. The probe that verifies the
 * final URL is stubbed too, and records which URL the app asked it to fetch.
 */
async function fakeVendors(page: Page, vendor: (r: Fwd) => { status?: number; json: unknown } | undefined) {
  const calls: Fwd[] = []; const probed: string[] = [];
  await page.route("**/api/forward", async (route) => {
    const env = JSON.parse(route.request().postData() ?? "{}");
    const r: Fwd = { method: env.method, url: new URL(env.url), headers: env.headers ?? {}, body: env.body ?? undefined, bytes: env.bodyBase64 ? Buffer.from(env.bodyBase64, "base64") : undefined };
    calls.push(r);
    const out = vendor(r) ?? { status: 404, json: { message: `unexpected ${r.method} ${r.url.href}` } };
    return route.fulfill({ status: out.status ?? 200, contentType: "application/json", body: JSON.stringify(out.json) });
  });
  await page.route("**/api/probe", async (route) => {
    const { url } = JSON.parse(route.request().postData() ?? "{}"); probed.push(url);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: 200, ms: 42, finalUrl: url, title: "Hello" }) });
  });
  return { calls, probed };
}
const key = (c: Fwd) => `${c.method} ${c.url.host}${c.url.pathname}`;

async function siteProject(page: Page) {
  await page.goto("/#/workspace");
  await page.locator("input[type=file]").first().setInputFiles({ name: "index.html", mimeType: "text/html", buffer: Buffer.from("<h1>Hello static</h1>") });
  await page.waitForTimeout(400);
  await page.locator("input[type=file]").first().setInputFiles({ name: "style.css", mimeType: "text/css", buffer: Buffer.from("h1{color:red}") });
  await page.waitForTimeout(600);
  await page.goto("/#/deployments");
  return page.getByRole("region", { name: "Static hosting" });
}

test("Netlify: token verified and vaulted, approval first, ZIP deploy via the forwarder, the URL shown is the one the API returned", async ({ page }) => {
  const errors = await prepare(page);
  const STUB_URL = "https://e2e-reported-by-netlify-stub.example.net";
  let polls = 0;
  const v = await fakeVendors(page, (r) => {
    if (r.url.host !== "api.netlify.com") return undefined;
    const k = `${r.method} ${r.url.pathname}`;
    if (k === "GET /api/v1/user") return { json: { email: "e2e@example.com", full_name: "E2E" } };
    if (k === "GET /api/v1/sites") return { json: [] };
    if (k === "POST /api/v1/sites") return { status: 201, json: { id: "site_e2e", name: JSON.parse(r.body!).name } };
    if (k === "POST /api/v1/sites/site_e2e/deploys") return { json: { id: "dep_e2e", site_id: "site_e2e", state: "uploaded" } };
    if (k === "GET /api/v1/deploys/dep_e2e") return { json: ++polls < 2 ? { id: "dep_e2e", state: "processing" } : { id: "dep_e2e", state: "ready", ssl_url: STUB_URL, deploy_ssl_url: "https://dep_e2e--stub.netlify.app" } };
    return undefined;
  });
  await page.goto("/#/integrations");
  await page.getByLabel("Netlify token").fill("e2e-fake-netlify-token-not-real");
  await page.locator("form").filter({ has: page.getByLabel("Netlify token") }).getByRole("button", { name: "Verify & save" }).click();
  await expect(page.getByText("Netlify connected (e2e@example.com)")).toBeVisible();
  expect(v.calls.map(key)).toEqual(["GET api.netlify.com/api/v1/user"]);
  expect(v.calls[0]!.headers.authorization).toBe("Bearer e2e-fake-netlify-token-not-real");

  const panel = await siteProject(page);
  await expect(panel.getByText("Netlify connected")).toBeVisible();
  await panel.getByLabel("Site name").fill("e2e-site");
  await panel.getByRole("button", { name: "Deploy to Netlify" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Deploy “e2e-site” to Netlify?");
  await expect(dialog).toContainText("2 files will be uploaded as-is");
  expect(v.calls.length).toBe(1); // nothing sent before approval
  await dialog.getByRole("button", { name: "Allow once" }).click();
  await expect(panel.getByTestId("static-deploy-state")).toContainText("Live", { timeout: 20_000 });
  // the URL shown (and probed) is exactly the one the stub returned
  await expect(panel.getByRole("link", { name: STUB_URL })).toHaveAttribute("href", STUB_URL);
  expect(v.probed).toEqual([STUB_URL]);
  // the exact wire protocol
  expect(v.calls.map(key)).toEqual(["GET api.netlify.com/api/v1/user", "GET api.netlify.com/api/v1/sites", "POST api.netlify.com/api/v1/sites", "POST api.netlify.com/api/v1/sites/site_e2e/deploys", "GET api.netlify.com/api/v1/deploys/dep_e2e", "GET api.netlify.com/api/v1/deploys/dep_e2e"]);
  expect(v.calls[1]!.url.search).toBe("?name=e2e-site&filter=all");
  expect(JSON.parse(v.calls[2]!.body!)).toEqual({ name: "e2e-site" });
  const up = v.calls[3]!;
  expect(up.headers["content-type"]).toBe("application/zip");
  expect(up.body).toBeUndefined();
  const { unzipSync, strFromU8 } = await import("fflate");
  const zip = unzipSync(new Uint8Array(up.bytes!));
  expect(Object.keys(zip).sort()).toEqual(["index.html", "style.css"]);
  expect(strFromU8(zip["index.html"]!)).toBe("<h1>Hello static</h1>");
  expect(v.calls.every((c) => c.headers.authorization === "Bearer e2e-fake-netlify-token-not-real")).toBe(true);
  // recorded in history and in the audit trail
  await expect(page.getByText(/live — verified HTTP 200 in 42 ms/)).toBeVisible();
  await page.goto("/#/settings");
  await page.getByRole("tab", { name: "Diagnostics" }).click();
  await expect(page.getByTestId("audit-trail")).toContainText("approved");
  await expect(page.getByTestId("audit-trail")).toContainText("netlify deploy ready");
  await expect(page.getByTestId("audit-trail")).toContainText(STUB_URL);
  noErrors(errors);
});

test("Cloudflare Pages: token + account verified, approval first, wrangler's Direct Upload sequence, the URL shown is the one the API returned", async ({ page }) => {
  const errors = await prepare(page);
  const ACCT = "0123456789abcdef0123456789abcdef";
  const STUB_URL = "https://e2e1234.e2e-site-stub.pages.dev";
  const ok = (result: unknown) => ({ json: { success: true, errors: [], messages: [], result } });
  let polls = 0;
  const v = await fakeVendors(page, (r) => {
    if (r.url.host !== "api.cloudflare.com") return undefined;
    const proj = `/client/v4/accounts/${ACCT}/pages/projects/e2e-site`;
    const k = `${r.method} ${r.url.pathname}`;
    if (k === `GET /client/v4/accounts/${ACCT}/pages/projects`) return ok([]);
    if (k === `GET ${proj}`) return { status: 404, json: { success: false, errors: [{ code: 8000007, message: "Project not found." }], result: null } };
    if (k === `POST /client/v4/accounts/${ACCT}/pages/projects`) return ok({ name: "e2e-site", subdomain: "e2e-site-stub.pages.dev" });
    if (k === `GET ${proj}/upload-token`) return ok({ jwt: "e2e-upload-jwt" });
    if (k === "POST /client/v4/pages/assets/check-missing") return ok(JSON.parse(r.body!).hashes);
    if (k === "POST /client/v4/pages/assets/upload") return ok({ successful_key_count: JSON.parse(r.body!).length });
    if (k === "POST /client/v4/pages/assets/upsert-hashes") return ok(null);
    if (k === `POST ${proj}/deployments`) return ok({ id: "dep-e2e", url: STUB_URL, latest_stage: { name: "queued", status: "active" } });
    if (k === `GET ${proj}/deployments/dep-e2e`) return ok({ id: "dep-e2e", url: STUB_URL, aliases: ["https://preview.e2e-site-stub.pages.dev"], latest_stage: ++polls < 2 ? { name: "deploy", status: "active" } : { name: "deploy", status: "success" } });
    return undefined;
  });
  await page.goto("/#/integrations");
  await page.getByLabel("Cloudflare API token").fill("e2e-fake-cloudflare-token-not-real");
  await page.getByLabel("Cloudflare account ID").fill(ACCT);
  await page.locator("form").filter({ has: page.getByLabel("Cloudflare API token") }).getByRole("button", { name: "Verify & save" }).click();
  await expect(page.getByText("Cloudflare connected (0 Pages projects visible)")).toBeVisible();

  const panel = await siteProject(page);
  await panel.getByRole("radio", { name: "Cloudflare Pages" }).click();
  await panel.getByLabel("Project name").fill("e2e-site");
  await panel.getByRole("radio", { name: "Preview branch" }).click();
  await panel.getByRole("button", { name: "Deploy to Cloudflare Pages" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Deploy “e2e-site” to Cloudflare Pages?");
  await expect(dialog).toContainText("preview branch “preview”");
  expect(v.calls.length).toBe(1);
  await dialog.getByRole("button", { name: "Allow once" }).click();
  await expect(panel.getByTestId("static-deploy-state")).toContainText("Live", { timeout: 20_000 });
  await expect(panel.getByRole("link", { name: STUB_URL })).toHaveAttribute("href", STUB_URL);
  expect(v.probed).toEqual([STUB_URL]);
  const P = `api.cloudflare.com/client/v4/accounts/${ACCT}/pages/projects`;
  expect(v.calls.map(key)).toEqual([`GET ${P}`, `GET ${P}/e2e-site`, `POST ${P}`, `GET ${P}/e2e-site/upload-token`, "POST api.cloudflare.com/client/v4/pages/assets/check-missing", "POST api.cloudflare.com/client/v4/pages/assets/upload", "POST api.cloudflare.com/client/v4/pages/assets/upsert-hashes", `POST ${P}/e2e-site/deployments`, `GET ${P}/e2e-site/deployments/dep-e2e`, `GET ${P}/e2e-site/deployments/dep-e2e`]);
  expect(v.calls.map((c) => c.headers.authorization)).toEqual([...Array(4).fill("Bearer e2e-fake-cloudflare-token-not-real"), ...Array(3).fill("Bearer e2e-upload-jwt"), ...Array(3).fill("Bearer e2e-fake-cloudflare-token-not-real")]);
  expect(JSON.parse(v.calls[2]!.body!)).toEqual({ name: "e2e-site", production_branch: "main" });
  const hashes: string[] = JSON.parse(v.calls[4]!.body!).hashes;
  expect(hashes).toHaveLength(2);
  expect(hashes.every((h) => /^[0-9a-f]{32}$/.test(h))).toBe(true);
  const uploaded = JSON.parse(v.calls[5]!.body!);
  expect(uploaded.map((a: any) => a.key).sort()).toEqual([...hashes].sort());
  const html = uploaded.find((a: any) => a.metadata.contentType === "text/html");
  expect(html).toMatchObject({ base64: true, value: Buffer.from("<h1>Hello static</h1>").toString("base64") });
  const dep = v.calls[7]!;
  expect(dep.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  const form = await new Response(dep.body, { headers: { "content-type": dep.headers["content-type"]! } }).formData();
  const manifest = JSON.parse(String(form.get("manifest")));
  expect(Object.keys(manifest).sort()).toEqual(["/index.html", "/style.css"]);
  expect(manifest["/index.html"]).toBe(html.key);
  expect(form.get("branch")).toBe("preview");
  await page.goto("/#/settings");
  await page.getByRole("tab", { name: "Diagnostics" }).click();
  await expect(page.getByTestId("audit-trail")).toContainText("cloudflare deploy ready");
  // The project lookup answers 404 (it does not exist yet) — the browser logs that as a console error by itself.
  noErrors(errors.filter((e) => !/status of 404/.test(e)));
});

test("Netlify: denying the approval sends nothing; a failed deploy is shown as failed, never as live", async ({ page }) => {
  const errors = await prepare(page);
  const v = await fakeVendors(page, (r) => {
    const k = `${r.method} ${r.url.pathname}`;
    if (k === "GET /api/v1/user") return { json: { email: "e2e@example.com" } };
    if (k === "GET /api/v1/sites") return { json: [{ id: "site_x", name: "e2e-site" }] };
    if (k === "POST /api/v1/sites/site_x/deploys") return { json: { id: "dep_x", state: "uploaded" } };
    if (k === "GET /api/v1/deploys/dep_x") return { json: { id: "dep_x", state: "error", error_message: "Deploy rejected: e2e stub failure" } };
    return undefined;
  });
  await page.goto("/#/integrations");
  await page.getByLabel("Netlify token").fill("e2e-fake-netlify-token-not-real");
  await page.locator("form").filter({ has: page.getByLabel("Netlify token") }).getByRole("button", { name: "Verify & save" }).click();
  await expect(page.getByText("Netlify connected (e2e@example.com)")).toBeVisible();
  const panel = await siteProject(page);
  await panel.getByLabel("Site name").fill("e2e-site");
  await panel.getByRole("button", { name: "Deploy to Netlify" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Deny" }).click();
  await expect(panel.getByTestId("static-deploy-state")).toContainText("Cancelled");
  expect(v.calls.map(key)).toEqual(["GET api.netlify.com/api/v1/user"]);
  await panel.getByRole("button", { name: "Deploy to Netlify" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Allow once" }).click();
  await expect(panel.getByTestId("static-deploy-state")).toContainText("Failed", { timeout: 20_000 });
  await expect(panel.getByTestId("static-deploy-state")).toContainText("e2e stub failure");
  await expect(panel.getByTestId("static-deploy-state")).not.toContainText("Live");
  expect(v.probed).toEqual([]); // nothing to verify — and nothing claimed
  expect(v.calls.map(key)).not.toContain("POST api.netlify.com/api/v1/sites"); // the existing site was reused
  await expect(page.getByText(/^failed — Deploy rejected: e2e stub failure/)).toBeVisible();
  noErrors(errors);
});
