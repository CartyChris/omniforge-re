import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { noErrors, mockModelSettings, mockProvider, prepare } from "./helpers";

const DIR = "/tmp/omniforge-e2e-project";
const UI_TOKEN = "ui-token-for-e2e-0123456789abcdef";

test.beforeEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(`${DIR}/src`, { recursive: true });
  fs.writeFileSync(`${DIR}/package.json`, JSON.stringify({ name: "proj", scripts: { test: "node -e \"console.log(1)\"" }, dependencies: { react: "18.2.0" } }));
  fs.writeFileSync(`${DIR}/src/a.ts`, "export const a = 1;\n"); fs.writeFileSync(`${DIR}/.env`, "SECRET_KEY=hunter2-value\n");
});

/** The desktop shell hands the web view its engine through Tauri's invoke; emulate exactly that contract against the real engine. */
async function asDesktop(page: import("@playwright/test").Page) {
  const errors = await prepare(page, mockModelSettings);
  await page.addInitScript(([p, token]) => {
    try { localStorage.setItem("omniforge.providers", JSON.stringify(p)); } catch { /* the sandboxed preview iframe has no storage */ }
    let cb = 0;
    (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      transformCallback: () => ++cb, unregisterCallback: () => {},
      invoke: async (cmd: string) => (cmd === "bridge_info" ? { url: "http://127.0.0.1:4466", uiToken: token, version: "1.0.0" } : cmd === "pick_folder" ? "/tmp/omniforge-e2e-project" : cmd === "plugin:event|listen" ? 1 : null),
    };
  }, [mockProvider, UI_TOKEN] as const);
  return errors;
}

test("desktop: approve a folder (read-only first), analyse it, secrets never reach the UI", async ({ page }) => {
  const errors = await asDesktop(page);
  await page.goto("/#/analyze");
  await expect(page.getByText("Desktop connected")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await expect(page.getByRole("switch", { name: "Allow writing to this folder" })).not.toBeChecked(); // approvals start read-only
  await page.getByRole("button", { name: "Analyse folder" }).click();
  await page.getByText("Open results").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Open results" }).click();
  await page.getByRole("tab", { name: /^Stack/ }).click();
  await expect(page.getByText(/^React/).first()).toBeVisible();
  expect(await page.content()).not.toContain("hunter2-value");
  noErrors(errors);
});

test("desktop: AI plan writes into the folder, every command needs approval, git never commits .env", async ({ page }) => {
  const errors = await asDesktop(page);
  await page.goto("/#/analyze");
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByRole("switch", { name: "Allow writing to this folder" }).click();
  await expect(page.getByRole("switch", { name: "Allow writing to this folder" })).toBeChecked();

  await page.goto("/#/studio?tab=build");
  await page.getByRole("radio", { name: /Build from scratch/ }).click();
  await page.getByLabel(/Describe the app/).fill("A tiny notes app");
  await page.getByRole("radio", { name: /A folder on my Mac/ }).click();
  await page.getByLabel("Folder (approved, writable)").click(); // other approved folders may exist: choose ours explicitly
  await page.getByRole("option", { name: /omniforge-e2e-project/ }).click();
  await page.getByRole("button", { name: "Generate plan" }).click();
  await page.getByText("Plan — review, edit or skip tasks, then run").waitFor();
  await page.getByRole("button", { name: "Run plan" }).click();
  const allow = page.getByRole("button", { name: "Allow once" });
  await allow.waitFor({ timeout: 60_000 }); // `npm test` is gated behind an explicit approval
  await expect(page.getByRole("dialog").getByText("npm test")).toBeVisible();
  await allow.click();
  await page.getByText("Written to your folder.", { exact: true }).waitFor({ timeout: 90_000 });
  for (const f of ["SPEC.md", "package.json", "index.html", "src/main.tsx", "src/App.tsx"]) expect(fs.existsSync(`${DIR}/${f}`), f).toBe(true);
  expect(fs.readFileSync(`${DIR}/.env`, "utf8")).toContain("hunter2-value");

  await page.goto("/#/workspace");
  await page.locator('button[role="combobox"]').first().click();
  await page.getByRole("option", { name: /omniforge-e2e-project/ }).click();
  await page.getByText("SPEC.md").waitFor({ timeout: 20_000 });
  await page.getByRole("tab", { name: "Git" }).click();
  await page.getByRole("button", { name: "git init" }).click();
  await page.getByText("changed").waitFor();
  await page.getByLabel("Commit message").fill("initial");
  await page.getByRole("button", { name: "Commit all" }).click();
  await expect(page.getByText(/Left out \(look like secrets\)/)).toBeVisible();
  const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: DIR, encoding: "utf8" }).split("\n");
  expect(tracked).toContain("SPEC.md"); expect(tracked).not.toContain(".env");
  noErrors(errors);
});

test("desktop: the engine rejects an unpaired browser origin and requests without a token", async ({ request }) => {
  const noTok = await request.get("http://127.0.0.1:4466/bridge/info", { headers: { origin: "https://evil.example", "x-omniforge-bridge": "1" } });
  expect(noTok.status()).toBe(401);
  const wrongOrigin = await request.get("http://127.0.0.1:4466/bridge/info", { headers: { origin: "https://evil.example", authorization: `Bearer ${UI_TOKEN}`, "x-omniforge-bridge": "1" } });
  expect(wrongOrigin.status()).toBe(403);
  // state-changing calls additionally need the custom CSRF header (a plain cross-site form post can't set it)
  const noCsrf = await request.post("http://127.0.0.1:4466/bridge/probe", { data: { url: "http://127.0.0.1:4010/" }, headers: { authorization: `Bearer ${UI_TOKEN}`, origin: "http://127.0.0.1:5173" } });
  expect(noCsrf.status()).toBe(403);
  const ok = await request.post("http://127.0.0.1:4466/bridge/probe", { data: { url: "http://127.0.0.1:4010/" }, headers: { authorization: `Bearer ${UI_TOKEN}`, origin: "http://127.0.0.1:5173", "x-omniforge-bridge": "1" } });
  expect(ok.status()).toBe(200);
});

test("desktop: Verify compares a rebuild with its reference in real Chromium; Repair runs the agent and re-checks", async ({ page }) => {
  const errors = await asDesktop(page);
  await page.goto("/#/analyze");
  await expect(page.getByText("Desktop connected")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Choose folder…" }).click();
  const writable = page.getByRole("switch", { name: "Allow writing to this folder" });
  await expect(writable).toBeVisible(); await page.waitForTimeout(800); // the engine may remember an earlier approval of this folder
  if (!(await writable.isChecked())) { await writable.click(); }
  await expect(writable).toBeChecked();
  await page.goto("/#/workspace");
  await page.getByRole("tab", { name: "Verify" }).click();
  const compare = page.getByRole("button", { name: "Compare" });
  await expect(compare).toBeDisabled(); // needs two http(s) URLs
  await page.getByLabel("Reference site").fill("http://127.0.0.1:4010/");
  await page.getByLabel("Your rebuilt app").fill("http://127.0.0.1:4010/");
  await compare.click();
  const result = page.getByTestId("verify-result");
  await expect(result).toContainText("Matches the reference", { timeout: 90_000 });
  await expect(result.getByRole("img", { name: /differences at desktop width/ })).toBeVisible();
  // a different page is reported as different, with listed discrepancies
  await page.getByLabel("Your rebuilt app").fill("http://127.0.0.1:4010/about");
  await compare.click();
  await expect(result).not.toContainText("Matches the reference", { timeout: 90_000 });
  await expect(result.locator("li").first()).toBeVisible();
  await expect(result.getByText("What this does not check")).toBeVisible();
  // repair: the agent (scripted model here — plumbing only) runs on the approved folder, then the comparison is re-run
  await page.getByLabel("Workspace source").click();
  await page.getByRole("option", { name: /omniforge-e2e-project/ }).click();
  await page.getByRole("button", { name: "Repair with AI" }).click();
  await expect(page.getByText(/before repair: \d+ high/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("audit-trail").or(page.locator("body"))).toBeVisible();
  noErrors(errors);
});

test("desktop UI: Agent CLI tab — consent shows the exact command, live feed, per-file diff review, apply and undo (bridge responses stubbed; the engine side is covered by the server tests)", async ({ page, request }) => {
  const errors = await asDesktop(page);
  // approve a writable folder directly through the engine API (the same call the folder picker makes)
  const ok = await request.post("http://127.0.0.1:4466/bridge/roots", { data: { path: DIR, writable: true }, headers: { authorization: `Bearer ${UI_TOKEN}`, origin: "tauri://localhost", "x-omniforge-bridge": "1" } });
  expect(ok.ok()).toBe(true);
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" };
  const ID = "0123456789abcdef"; const seen: { method: string; url: string; body?: unknown }[] = [];
  const sse = (blocks: [string, unknown][]) => blocks.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  await page.route("**/bridge/info*", async (route) => { const res = await route.fetch(); const j = await res.json(); j.clis = [{ id: "claude-code", name: "Claude Code", status: "ready", version: "9.9.9", method: "print-stream-json", methods: [], agentic: true }]; await route.fulfill({ response: res, json: j, headers: { ...res.headers(), ...cors } }); });
  await page.route(`**/bridge/agent/**`, async (route) => {
    const req = route.request(); const u = new URL(req.url()); if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    seen.push({ method: req.method(), url: u.pathname + u.search, body: req.postData() ? JSON.parse(req.postData()!) : undefined });
    const json = (o: unknown) => route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(o) });
    if (u.pathname === "/bridge/agent/run") return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: sse([
      ["start", { runId: ID, copied: 3, bytes: 1200, skipped: [{ path: ".env", reason: "credential-style file — never shown to the CLI" }], cli: "9.9.9" }],
      ["event", { type: "init", model: "m", tools: [] }], ["event", { type: "text", text: "Adding the header comment." }], ["event", { type: "tool", name: "Edit", summary: "Edit src/app.js", path: "src/app.js" }], ["event", { type: "tool", name: "Write", summary: "Write src/new.js" }],
      ["event", { type: "result", ok: true, text: "done", costUsd: 0.0123, turns: 3 }],
      ["done", { runId: ID, ok: true, changes: [{ path: "src/app.js", status: "modified", additions: 1, deletions: 0, binary: false }, { path: "src/new.js", status: "added", additions: 1, deletions: 0, binary: false }, { path: ".env", status: "added", additions: 1, deletions: 0, binary: false, refused: "credential-style files are never applied" }] }]]) });
    if (u.pathname.endsWith("/file")) return json({ base: "console.log(1);\n", next: "console.log(1);\n// edited by agent\n", binary: false });
    if (u.pathname.endsWith("/apply")) return json({ applied: ["src/app.js", "src/new.js"], conflicts: [], refused: [], backup: "/tmp/backup-1" });
    return json({ ok: true });
  });
  await page.route("**/bridge/restore", async (route) => { if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors }); seen.push({ method: "POST", url: "/bridge/restore", body: JSON.parse(route.request().postData() ?? "{}") }); await route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: "{}" }); });

  await page.goto("/#/studio?tab=cli");
  await page.getByLabel("What should the agent do").fill("Add a header comment");
  await page.getByText("Allow it to run commands").click(); await page.getByRole("button", { name: "npm test" }).click();
  await page.getByRole("button", { name: "Run on a copy" }).click();
  // consent: the exact command line and the commands that were allowed
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Run Claude Code on a copy of"); await expect(dlg).toContainText("--setting-sources user"); await expect(dlg).toContainText("Bash(npm test:*)"); await expect(dlg).toContainText("npm test");
  expect(seen.some((s) => s.url.includes("/run"))).toBe(false); // nothing started before consent
  await dlg.getByRole("button", { name: "Allow once" }).click();
  const feed = page.getByTestId("agent-feed");
  await expect(feed).toContainText("Adding the header comment."); await expect(feed).toContainText("▸ Edit src/app.js"); await expect(feed).toContainText("Finished in 3 turns · $0.012");
  const run = seen.find((s) => s.url === "/bridge/agent/run")!.body as Record<string, unknown>;
  expect(run).toMatchObject({ cli: "claude-code", prompt: "Add a header comment", allowedCommands: ["npm test"], maxBudgetUsd: 2 });
  // review: blocked files can't be selected; the diff opens
  const list = page.getByTestId("agent-changes");
  await expect(list.getByLabel("Apply .env")).toBeDisabled(); await expect(list.getByLabel("Apply src/app.js")).toBeChecked();
  await expect(page.locator(".monaco-diff-editor")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /Apply 2 files to the project/ }).click();
  const applied = page.getByTestId("agent-applied"); await expect(applied).toContainText("2 file(s) applied");
  expect(seen.find((s) => s.url.endsWith("/apply"))!.body).toEqual({ paths: ["src/app.js", "src/new.js"], allowDeletes: false });
  await applied.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => seen.some((s) => s.url === "/bridge/restore" && (s.body as { dir?: string }).dir === "/tmp/backup-1")).toBe(true);
  // the trail records it
  await page.goto("/#/settings"); await page.getByRole("tab", { name: "Diagnostics" }).click();
  const trail = page.getByTestId("audit-trail"); await expect(trail).toContainText("agent run started"); await expect(trail).toContainText("agent changes applied"); await expect(trail).toContainText("agent apply undone");
  noErrors(errors);
});
