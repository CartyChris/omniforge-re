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
