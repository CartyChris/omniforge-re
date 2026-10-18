import { expect, test } from "@playwright/test";
import { noErrors, mockModelSettings, mockProvider, prepare } from "./helpers";

test("workspace: edit with Monaco (local workers), sandboxed preview, checkpoint diff, persistence", async ({ page }) => {
  const errors = await prepare(page);
  await page.goto("/#/workspace");
  await page.locator("input[type=file]").first().setInputFiles({ name: "index.html", mimeType: "text/html", buffer: Buffer.from('<h1 id="hi">Hello</h1><script>document.getElementById("hi").style.color="rgb(1, 2, 3)"</script>') });
  await page.getByText("index.html").first().click();
  await page.waitForSelector(".monaco-editor");
  const frame = page.frameLocator('iframe[title="Preview"]');
  await expect(frame.locator("#hi")).toBeVisible();
  expect(await frame.locator("#hi").evaluate((e) => getComputedStyle(e).color)).toBe("rgb(1, 2, 3)"); // preview JS runs…
  expect(await page.locator('iframe[title="Preview"]').getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-modals"); // …but is isolated from the app (no same-origin)
  // no request ever left for a CDN: Monaco is served from this origin
  const external = new Set<string>(); page.on("request", (r) => { const u = new URL(r.url()); if (!["127.0.0.1", "localhost"].includes(u.hostname) && u.protocol.startsWith("http")) external.add(u.hostname); });
  await page.getByRole("tab", { name: "History" }).click();
  await page.getByLabel("Checkpoint label").fill("first");
  await page.getByRole("button", { name: "Save" }).click();
  await page.locator(".monaco-editor").first().click();
  await page.keyboard.press("Control+End"); await page.keyboard.type(" second");
  await page.getByRole("button", { name: "Diff" }).click();
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForTimeout(800);
  const persisted = await page.evaluate(() => new Promise<boolean>((res) => { const r = indexedDB.open("omniforge"); r.onsuccess = () => { const g = r.result.transaction("kv").objectStore("kv").getAll(); g.onsuccess = () => res(JSON.stringify(g.result).includes("second")); }; }));
  expect(persisted).toBe(true);
  expect([...external]).toEqual([]);
  noErrors(errors);
});

test("workspace AI edit: shown as a diff, nothing changes until accepted; abbreviated and cut-off replies are rejected", async ({ page }) => {
  const errors = await prepare(page, mockModelSettings);
  await page.addInitScript((p) => { try { localStorage.setItem("omniforge.providers", JSON.stringify(p)); } catch { /* sandboxed */ } }, mockProvider);
  await page.goto("/#/workspace");
  await page.locator("input[type=file]").first().setInputFiles({ name: "app.js", mimeType: "text/javascript", buffer: Buffer.from("const a = 1;\nconsole.log(a);\n") });
  await page.getByText("app.js").first().click();
  await page.waitForSelector(".monaco-editor");
  await page.getByRole("tab", { name: /^AI/ }).click();
  await expect(page.getByText(/Using/)).toBeVisible({ timeout: 15_000 });
  const lines = page.locator(".monaco-editor .view-lines");

  // 1) propose → diff + banner; the real file is untouched until Accept
  await page.getByLabel("Describe the change").fill("add a header");
  await page.getByRole("button", { name: "Propose edit" }).click();
  const banner = page.getByRole("region", { name: "AI proposal" });
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toContainText("+1");
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await banner.getByRole("button", { name: "Reject" }).click();
  await expect(page.locator(".monaco-diff-editor")).toHaveCount(0);
  await expect(lines).not.toContainText("edited by scripted mock");

  // 2) propose again → accept → the file now has the change, and Undo restores it
  await page.getByLabel("Describe the change").fill("add a header");
  await page.getByRole("button", { name: "Propose edit" }).click();
  await banner.getByRole("button", { name: "Accept changes" }).click();
  await expect(lines).toContainText("edited by scripted mock: add a header");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(lines).not.toContainText("edited by scripted mock");

  // 3) a model that abbreviates the file ("// ... rest unchanged") or gets cut off is refused — nothing to accept
  await page.getByLabel("Describe the change").fill("ABBREVIATE this");
  await page.getByRole("button", { name: "Propose edit" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /abbreviated the file/ })).toBeVisible({ timeout: 20_000 });
  await expect(banner).toHaveCount(0);
  await page.getByLabel("Describe the change").fill("TRUNCATE this");
  await page.getByRole("button", { name: "Propose edit" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /cut off/ })).toBeVisible({ timeout: 20_000 });
  await expect(banner).toHaveCount(0);

  // 4) explain returns an answer without proposing any change
  await page.getByRole("button", { name: "Explain" }).click();
  await expect(page.getByTestId("ai-answer")).toContainText("mock answer", { timeout: 20_000 });
  await expect(banner).toHaveCount(0);

  // 5) every step is in the audit trail
  await page.goto("/#/settings");
  await page.getByRole("tab", { name: "Diagnostics" }).click();
  const trail = page.getByTestId("audit-trail");
  await expect(trail).toContainText("ai edit proposed");
  await expect(trail).toContainText("ai edit applied");
  await expect(trail).toContainText("ai edit rejected");
  await expect(trail).toContainText("ai edit undone");
  noErrors(errors);
});
