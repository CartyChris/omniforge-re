import { expect, test } from "@playwright/test";
import { noErrors, prepare } from "./helpers";

test("command palette searches across investigations and deep-links to the hit's tab", async ({ page }) => {
  const errors = await prepare(page);
  await page.goto("/#/analyze");
  await page.getByLabel(/Website URL, GitHub repository/).fill("http://127.0.0.1:4010/");
  await page.getByRole("button", { name: /Analyze/ }).last().click();
  await page.getByText("Open results").waitFor({ timeout: 90_000 });

  await page.keyboard.press("Control+k");
  const input = page.getByPlaceholder(/search commands/);
  await input.fill("ab"); // under 3 characters: no content search
  await expect(page.getByText("Search results")).toHaveCount(0);
  await input.fill("about");
  await expect(page.getByText("Search results")).toBeVisible();
  const hit = page.locator("[cmdk-item]", { hasText: "/about" }).first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page).toHaveURL(/#\/investigations\/[^?]+\?tab=/);
  await expect(page.getByRole("tab", { selected: true })).toBeVisible();
  noErrors(errors);
});
