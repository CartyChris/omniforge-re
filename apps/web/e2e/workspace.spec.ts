import { expect, test } from "@playwright/test";
import { noErrors, prepare } from "./helpers";

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
