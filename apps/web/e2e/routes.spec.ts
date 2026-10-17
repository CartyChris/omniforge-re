import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { noErrors, prepare } from "./helpers";

const ROUTES = ["", "analyze", "repo-rip", "investigations", "applications", "features", "studio", "workspace", "models", "integrations", "deployments", "settings"];

for (const r of ROUTES) {
  test(`/${r || "dashboard"}: renders, no console errors, no horizontal scroll, no serious a11y violations`, async ({ page }) => {
    const errors = await prepare(page);
    await page.goto(`/#/${r}`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("main")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "horizontal overflow").toBe(true);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).disableRules(["color-contrast"]).analyze(); // contrast is audited manually per theme
    const bad = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`), "a11y").toEqual([]);
    noErrors(errors);
  });
}

test("keyboard: command palette opens with Ctrl/Cmd+K and navigates", async ({ page }) => {
  await prepare(page);
  await page.goto("/#/");
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Type a URL, a GitHub repo/).fill("settings");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/settings/);
});

test("first run: onboarding appears once and the choice is remembered", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByRole("heading", { name: "Welcome to OmniForge RE" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Welcome to OmniForge RE" })).toHaveCount(0);
});
