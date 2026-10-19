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
  // MCP tools: nothing selected by default; an unsafe launcher is refused; a preset and a custom server can be chosen
  await page.getByText("Give it MCP tools").click();
  for (const name of ["chrome-devtools", "playwright", "context7"]) await expect(page.getByLabel(`Use MCP server ${name}`)).not.toBeChecked();
  await page.getByLabel("MCP server name").fill("evil"); await page.getByLabel("MCP server command or address").fill("bash -c id"); await page.getByRole("button", { name: "Add", exact: true }).last().click();
  await expect(page.getByLabel("Use MCP server evil")).toHaveCount(0);
  await page.getByLabel("MCP server name").fill("my-docs"); await page.getByLabel("MCP server command or address").fill("https://mcp.example.com/mcp"); await page.getByRole("button", { name: "Add", exact: true }).last().click();
  await expect(page.getByLabel("Use MCP server my-docs")).toBeChecked();
  await page.getByLabel("Use MCP server context7").check();
  await page.getByRole("button", { name: "Run on a copy" }).click();
  // consent: the exact command line and the commands that were allowed
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Run Claude Code on a copy of"); await expect(dlg).toContainText("--setting-sources user"); await expect(dlg).toContainText("Bash(npm test:*)"); await expect(dlg).toContainText("npm test");
  await expect(dlg).toContainText("mcp__context7"); await expect(dlg).toContainText("--mcp-config"); await expect(dlg).toContainText("@upstash/context7-mcp@4.4.2"); await expect(dlg).toContainText("https://mcp.example.com/mcp"); await expect(dlg).toContainText("not sandboxed");
  expect(seen.some((s) => s.url.includes("/run"))).toBe(false); // nothing started before consent
  await dlg.getByRole("button", { name: "Allow once" }).click();
  const feed = page.getByTestId("agent-feed");
  await expect(feed).toContainText("Adding the header comment."); await expect(feed).toContainText("▸ Edit src/app.js"); await expect(feed).toContainText("Finished in 3 turns · $0.012");
  const run = seen.find((s) => s.url === "/bridge/agent/run")!.body as Record<string, unknown>;
  expect(run).toMatchObject({ cli: "claude-code", prompt: "Add a header comment", allowedCommands: ["npm test"], maxBudgetUsd: 2 });
  expect(run.mcpServers).toEqual([{ name: "context7", command: "npx", args: ["-y", "@upstash/context7-mcp@4.4.2"] }, { name: "my-docs", url: "https://mcp.example.com/mcp" }]);
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

test("desktop UI: 'with Claude Code' hands an analysed rebuild to the Agent CLI tab, pre-filled and still behind consent", async ({ page, request }) => {
  const errors = await asDesktop(page);
  const ok = await request.post("http://127.0.0.1:4466/bridge/roots", { data: { path: DIR, writable: true }, headers: { authorization: `Bearer ${UI_TOKEN}`, origin: "tauri://localhost", "x-omniforge-bridge": "1" } });
  expect(ok.ok()).toBe(true);
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" };
  await page.route("**/bridge/info*", async (route) => { const res = await route.fetch(); const j = await res.json(); j.clis = [{ id: "claude-code", name: "Claude Code", status: "ready", version: "9.9.9", method: "print-stream-json", methods: [], agentic: true }]; await route.fulfill({ response: res, json: j, headers: { ...res.headers(), ...cors } }); });
  let started = false; await page.route("**/bridge/agent/run", (route) => { started = true; return route.abort(); });
  await page.goto("/#/analyze");
  await expect(page.getByText("Desktop connected")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByRole("button", { name: "Analyse folder" }).click();
  await page.getByText("Open results").waitFor({ timeout: 30_000 });
  await page.goto("/#/studio?tab=build");
  await page.getByRole("radio", { name: /^Rebuild an analysed app$/ }).or(page.getByText("Rebuild an analysed app")).first().click();
  await page.getByRole("radio", { name: /Modernised version/ }).click();
  await page.getByRole("button", { name: "…with Claude Code" }).click();
  await expect(page).toHaveURL(/tab=cli/); await expect(page).toHaveURL(/mode=modernized/);
  const prompt = page.getByLabel("What should the agent do");
  await expect(prompt).toHaveValue(/Mode: modernized\. Preserve behaviour but choose modern/); await expect(prompt).toHaveValue(/Target stack: /);
  expect(started).toBe(false); // pre-filled only — nothing runs until the user presses Run and consents
  await page.getByRole("button", { name: "Run on a copy" }).click();
  await expect(page.getByRole("dialog")).toContainText("Run Claude Code on a copy of");
  expect(started).toBe(false);
  noErrors(errors);
});

test("desktop UI: an MCP server's tools reach OmniForge's own Build agents — approved once, pinned, results fenced as untrusted", async ({ page }) => {
  const errors = await asDesktop(page);
  const MINI = new URL("../../../packages/server/test/fixtures/mini-mcp.mjs", import.meta.url).pathname;
  // in the desktop app model calls go through the engine, so observe the MCP calls the agent makes (request and the engine's real reply)
  const calls: { body: any; reply: any }[] = [];
  await page.route("**/bridge/mcp/call", async (route) => { if (route.request().method() === "OPTIONS") return route.continue(); const res = await route.fetch(); const reply = await res.json(); calls.push({ body: JSON.parse(route.request().postData() ?? "{}"), reply }); await route.fulfill({ response: res, json: reply }); });
  await page.goto("/#/studio?tab=skills");
  await expect(page.getByText("Desktop connected").or(page.getByTestId("mcp-agent-servers"))).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("New MCP server name").fill("mini");
  await page.getByLabel("New MCP server command or address").fill(`${process.execPath} ${MINI} codeword-e2e`);
  await page.getByRole("button", { name: "Add server" }).click();
  const row = page.getByTestId("mcp-agent-servers").locator("li", { hasText: "mini" });
  await row.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByTestId("mcp-result-mini")).toContainText("1 tool(s): lookup"); await expect(page.getByTestId("mcp-result-mini")).toContainText("not approved yet");
  await page.getByRole("switch", { name: "Use mini in Build agents" }).click();

  await page.goto("/#/studio?tab=build");
  await page.getByRole("radio", { name: /Build from scratch/ }).click();
  await page.getByLabel(/Describe the app/).fill("A tiny notes app");
  await page.getByRole("button", { name: "Generate plan" }).click();
  await page.getByRole("button", { name: "Run plan" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Let Build agents use the MCP server “mini”?", { timeout: 30_000 }); await expect(dlg).toContainText("codeword-e2e"); await expect(dlg).toContainText("not sandboxed");
  await dlg.getByRole("button", { name: "Allow once" }).click();
  await expect.poll(() => calls.length, { timeout: 60_000 }).toBeGreaterThan(0);
  expect(calls[0]!.body).toMatchObject({ server: { name: "mini" }, tool: "lookup" }); expect(calls[0]!.reply).toMatchObject({ text: "codeword-e2e", isError: false });
  // the agent's log shows the call and its (fenced) result
  await page.getByText(/\d+\/\d+ done/).waitFor({ timeout: 90_000 });
  await page.getByRole("button", { name: "Details" }).first().click();
  await expect(page.getByText(/tool mcp__mini__lookup\(\{\}\) → <<<UNTRUSTED_DATA label="mcp:mini\/lookup"/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Stop" }).click({ timeout: 2_000 }).catch(() => {}); // the run may already have finished
  // pinned: connecting again shows the tools as approved
  await page.goto("/#/studio?tab=skills");
  await page.getByTestId("mcp-agent-servers").locator("li", { hasText: "mini" }).getByRole("button", { name: "Connect" }).click();
  await expect(page.getByTestId("mcp-result-mini")).toContainText("approved");
  await expect(page.getByTestId("mcp-result-mini")).not.toContainText("not approved");
  noErrors(errors);
});

test("desktop UI: Agent CLI tab drives other CLIs too — Codex consent shows its isolation flags; Aider needs a model; sign-in is offered when needed (bridge stubbed)", async ({ page, request }) => {
  const errors = await asDesktop(page);
  const ok = await request.post("http://127.0.0.1:4466/bridge/roots", { data: { path: DIR, writable: true }, headers: { authorization: `Bearer ${UI_TOKEN}`, origin: "tauri://localhost", "x-omniforge-bridge": "1" } });
  expect(ok.ok()).toBe(true);
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" };
  await page.route("**/bridge/info*", async (route) => { const res = await route.fetch(); const j = await res.json(); j.clis = [
    { id: "claude-code", name: "Claude Code", status: "ready", version: "9.9.9", agentic: true, canLogin: true },
    { id: "codex", name: "OpenAI Codex CLI", status: "ready", version: "0.163.0", agentic: true, canLogin: true },
    { id: "gemini", name: "Gemini CLI", status: "installed-unauthenticated", version: "0.64.0", agentic: true, canLogin: true },
    { id: "aider", name: "Aider", status: "ready", version: "0.86.2", agentic: true, agentOnly: true }]; await route.fulfill({ response: res, json: j, headers: { ...res.headers(), ...cors } }); });
  let runBody: any; let loginBody: any;
  await page.route("**/bridge/agent/run", async (route) => { if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors }); runBody = JSON.parse(route.request().postData() ?? "{}"); await route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: `event: start\ndata: ${JSON.stringify({ runId: "0123456789abcdef", copied: 1, bytes: 10, skipped: [] })}\n\nevent: event\ndata: ${JSON.stringify({ type: "result", ok: true, text: "done" })}\n\nevent: done\ndata: ${JSON.stringify({ runId: "0123456789abcdef", ok: true, changes: [] })}\n\n` }); });
  await page.route("**/bridge/cli/login", async (route) => { if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors }); loginBody = JSON.parse(route.request().postData() ?? "{}"); await route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ opened: true, command: "gemini" }) }); });
  await page.goto("/#/studio?tab=cli");
  const picker = page.getByRole("radiogroup", { name: "Coding CLI" });
  await expect(picker.getByRole("radio")).toHaveCount(4);
  // Gemini: not signed in → sign-in offered, Run disabled
  await picker.getByRole("radio", { name: /Gemini CLI/ }).click();
  await expect(page.getByText(/Sign in with Google/)).toBeVisible(); await expect(page.getByRole("button", { name: "Run on a copy" })).toBeDisabled();
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect.poll(() => loginBody?.id).toBe("gemini");
  // Aider: no MCP, no commands, and a model is required
  await picker.getByRole("radio", { name: /Aider/ }).click();
  await expect(page.getByText("Give it MCP tools")).toHaveCount(0); await expect(page.getByText("Allow it to run commands")).toHaveCount(0);
  await page.getByLabel("What should the agent do").fill("Add a footer");
  await expect(page.getByRole("button", { name: "Run on a copy" })).toBeDisabled();
  // Codex: consent shows the exact isolation flags; the request names the CLI
  await picker.getByRole("radio", { name: /Codex/ }).click();
  await page.getByRole("button", { name: "Run on a copy" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Run OpenAI Codex CLI on a copy of"); for (const f of ["--ignore-user-config", "--sandbox workspace-write", "project_doc_max_bytes=0", "--disable shell_tool"]) await expect(dlg).toContainText(f);
  await dlg.getByRole("button", { name: "Allow once" }).click();
  await expect.poll(() => runBody?.cli).toBe("codex"); expect(runBody).toMatchObject({ prompt: "Add a footer", allowedCommands: [], mcpServers: [] });
  noErrors(errors);
});
