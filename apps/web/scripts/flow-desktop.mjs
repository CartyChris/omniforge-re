import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
const out = process.argv[2];
// deterministic project folder (the previous run's scripted model overwrites files in it)
fs.rmSync("/tmp/of-project", { recursive: true, force: true }); fs.mkdirSync("/tmp/of-project/src", { recursive: true });
fs.writeFileSync("/tmp/of-project/package.json", JSON.stringify({ name: "proj", scripts: { test: "node -e \"console.log(1)\"" }, dependencies: { react: "18.2.0" } }));
fs.writeFileSync("/tmp/of-project/src/a.ts", "export const a = 1;\n"); fs.writeFileSync("/tmp/of-project/.env", "SECRET_KEY=hunter2-value\n");
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 300)); });
// The desktop shell hands the webview its bridge via Tauri's invoke; emulate exactly that contract.
await page.addInitScript(() => {
  try {
    localStorage.setItem("omniforge.settings", JSON.stringify({ onboarded: true, assignments: Object.fromEntries(["classify","extract","summarize","architecture","code","review","vision","embed","research","test"].map((k) => [k, "mock::mock-scripted-coder"])) })); localStorage.setItem("omniforge.ack", "1");
    localStorage.setItem("omniforge.providers", JSON.stringify([{ id: "mock", label: "Scripted mock model", kind: "openai-compat", preset: "custom", baseUrl: "http://127.0.0.1:4599/v1", local: true, enabled: true }]));
  } catch {}
  window.__TAURI_INTERNALS__ = { invoke: async (cmd) => (cmd === "bridge_info" ? { url: "http://127.0.0.1:4466", uiToken: "ui-token-for-e2e-0123456789abcdef", version: "0.1.0" } : cmd === "pick_folder" ? "/tmp/of-project" : null) };
});
await page.goto("http://127.0.0.1:5173/#/analyze", { waitUntil: "networkidle" });
await page.waitForSelector("text=Desktop connected", { timeout: 20000 });
// approve a folder, analyse it
await page.getByRole("button", { name: "Choose folder…" }).click();
await page.waitForTimeout(800);
await page.getByRole("switch", { name: "Allow writing to this folder" }).click(); // opt in to writes (needed for the AI build + editor)
await page.waitForTimeout(800);
await page.getByRole("button", { name: "Analyse folder" }).click();
await page.waitForSelector("text=Open results", { timeout: 30000 });
await page.screenshot({ path: out + "-desktop-analyze.png" });
await page.getByText("Open results").click();
await page.waitForSelector("text=Coverage checks");
const html = await page.content();
assert.ok(!html.includes("hunter2-value"), ".env value must never reach the UI");
await page.getByRole("tab", { name: /^Stack/ }).click();
await page.screenshot({ path: out + "-desktop-stack.png" });
assert.ok(await page.getByText(/^React/).first().isVisible(), "React detected from package.json");
// AI Studio plan → scripted model writes files into the real folder, then the approved test command runs on the Mac
await page.goto("http://127.0.0.1:5173/#/studio?tab=build", { waitUntil: "networkidle" });
await page.getByRole("radio", { name: /Build from scratch/ }).click();
await page.getByLabel(/Describe the app/).fill("A tiny notes app");
await page.getByRole("radio", { name: /A folder on my Mac/ }).click();
await page.getByRole("button", { name: "Generate plan" }).click();
await page.waitForSelector("text=Plan — review, edit or skip tasks, then run");
await page.screenshot({ path: out + "-desktop-plan.png" });
await page.getByRole("button", { name: "Run plan" }).click();
// every command needs explicit approval
await page.waitForTimeout(6000); await page.screenshot({ path: out + "-desktop-running.png", fullPage: true });
await page.getByRole("button", { name: "Allow once" }).waitFor({ timeout: 60000 });
await page.screenshot({ path: out + "-desktop-approval.png" });
await page.getByRole("button", { name: "Allow once" }).click();
await page.waitForSelector("text=Written to your folder.", { timeout: 90000 });
await page.screenshot({ path: out + "-desktop-done.png" });
for (const f of ["SPEC.md", "package.json", "index.html", "src/main.tsx", "src/App.tsx"]) assert.ok(fs.existsSync("/tmp/of-project/" + f), f + " must exist on disk");
assert.ok(fs.readFileSync("/tmp/of-project/.env", "utf8").includes("hunter2-value"), ".env untouched");
// local workspace sees the files and git panel works
await page.goto("http://127.0.0.1:5173/#/workspace", { waitUntil: "networkidle" });
await page.locator('button[role="combobox"]').first().click();
await page.getByRole("option", { name: /of-project/ }).click();
await page.waitForSelector("text=SPEC.md", { timeout: 20000 });
await page.getByRole("tab", { name: /Git/ }).click();
await page.getByRole("button", { name: "git init" }).click();
await page.waitForSelector("text=changed", { timeout: 20000 });
await page.screenshot({ path: out + "-desktop-workspace.png" });
console.log(errs.length ? errs.join("\n") : "no console errors");
await b.close();
