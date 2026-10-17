import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const out = process.argv[2];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 300)); });
await page.addInitScript(() => { try { localStorage.setItem("omniforge.settings", JSON.stringify({ onboarded: true })); localStorage.setItem("omniforge.ack", "1"); } catch {} });
await page.goto("http://127.0.0.1:5173/#/workspace", { waitUntil: "networkidle" });
await page.screenshot({ path: out + "-ws-empty.png" });
// create index.html through the upload control (typing into Monaco would be mangled by its auto-closing brackets)
await page.locator('input[type=file]').first().setInputFiles({ name: "index.html", mimeType: "text/html", buffer: Buffer.from('<h1 id="hi">Hello from OmniForge</h1><script>document.getElementById("hi").style.color="rgb(1, 2, 3)"</script>') });
await page.getByText("index.html").first().click();
await page.waitForSelector(".monaco-editor", { timeout: 30000 });
await page.waitForTimeout(900);
// static preview renders in sandboxed iframe and the script ran
await page.screenshot({ path: out + "-ws-typed.png" });
const frame = page.frameLocator('iframe[title="Preview"]');
await frame.locator("#hi").waitFor({ timeout: 10000 });
assert.equal(await frame.locator("#hi").evaluate((e) => getComputedStyle(e).color), "rgb(1, 2, 3)", "preview script must execute");
assert.equal(await page.locator('iframe[title="Preview"]').getAttribute("sandbox"), "allow-scripts allow-forms allow-modals", "preview must stay sandboxed (no same-origin)");
await page.screenshot({ path: out + "-ws-editor.png" });
// checkpoint + diff
await page.getByRole("tab", { name: /History/ }).click();
await page.getByLabel("Checkpoint label").fill("first");
await page.getByRole("button", { name: "Save" }).click();
await page.locator(".monaco-editor").first().click();
await page.keyboard.press("Control+End"); await page.keyboard.type(" second");
await page.waitForTimeout(900);
await page.getByRole("button", { name: "Diff" }).click();
await page.waitForSelector(".monaco-diff-editor", { timeout: 15000 });
await page.screenshot({ path: out + "-ws-diff.png" });
// persistence across reload
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);
const txt = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("omniforge"); r.onsuccess = () => { const tx = r.result.transaction("kv").objectStore("kv").getAll(); tx.onsuccess = () => res(JSON.stringify(tx.result).includes("second")); }; }));
assert.equal(txt, true, "edit must be persisted in IndexedDB");
await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(500);
await page.screenshot({ path: out + "-ws-mobile.png" });
console.log(errs.length ? errs.join("\n") : "no console errors");
await b.close();
