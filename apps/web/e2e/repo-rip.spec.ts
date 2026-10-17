import { expect, test } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import fs from "node:fs";
import { noErrors, prepare } from "./helpers";

let github = false;
test.beforeAll(async ({ request }) => { try { github = (await request.get("https://api.github.com/repos/octocat/Hello-World", { timeout: 8000 })).ok(); } catch { github = false; } });

test("Repo Rip: rights checkpoint blocks until attested, then exact copy has attribution; mesh of two repos", async ({ page }) => {
  test.skip(!github, "needs network access to GitHub");
  const errors = await prepare(page);
  await page.goto("/#/repo-rip");
  await page.getByLabel("Repositories", { exact: true }).fill("octocat/Hello-World");
  await page.getByRole("button", { name: "Inspect" }).click();
  await page.getByText("Rights checkpoint").waitFor({ timeout: 60_000 });
  const run = page.getByRole("button", { name: "Make the copy" });
  await expect(run).toBeDisabled(); // no licence ⇒ nothing is copied without an explicit attestation
  await page.getByLabel(/I own this code/).check();
  await run.click();
  await page.getByText("Copy ready").waitFor({ timeout: 60_000 });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download ZIP" }).click()]);
  const zip = unzipSync(new Uint8Array(fs.readFileSync((await dl.path())!)));
  expect(strFromU8(zip["README"]!)).toBe("Hello World!\n"); // byte-for-byte
  expect(strFromU8(zip["ATTRIBUTION.md"]!)).toContain("octocat/Hello-World");

  await page.goto("/#/repo-rip");
  await page.getByLabel("Repositories", { exact: true }).fill("octocat/Hello-World\noctocat/Spoon-Knife");
  await page.getByRole("button", { name: "Inspect" }).click();
  await page.getByText("Rights checkpoint").waitFor({ timeout: 60_000 });
  await page.getByLabel(/I own this code/).check();
  await page.getByRole("radio", { name: /Mesh together/ }).click();
  await page.getByRole("button", { name: "Mesh them" }).click();
  await page.getByText("Mesh ready").waitFor({ timeout: 60_000 });
  noErrors(errors);
});

test("a malformed repository reference is rejected with a clear message", async ({ page }) => {
  const errors = await prepare(page);
  await page.goto("/#/repo-rip");
  await page.getByLabel("Repositories", { exact: true }).fill("javascript:alert(1)");
  await expect(page.getByText(/not recognised/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Inspect" })).toBeDisabled(); // nothing valid to inspect
  void errors;
});
