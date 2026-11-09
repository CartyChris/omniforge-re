import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ACCENTS, CONTRAST, THEMES, contrastRatio } from "../src/lib/themes";
import { noErrors, prepare } from "./helpers";

const VARS = ["bg", "surface", "elevated", "overlay", "fg", "muted", "faint", "accent", "accent-fg", "ok", "warn", "bad", "info", "teal"];
const rendered = (page: Page) => page.evaluate((names) => { const cs = getComputedStyle(document.documentElement); return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(`--${n}`).trim()])); }, VARS);
const state = (page: Page) => page.evaluate(() => ({ mode: document.documentElement.getAttribute("data-theme"), palette: document.documentElement.getAttribute("data-palette") }));

test("choose a theme and an accent in Settings; both persist, the quick toggle and System mode work", async ({ page }) => {
  const errors = await prepare(page);
  await page.goto("/#/settings");
  await page.getByRole("radio", { name: "Nord theme" }).click();
  expect(await state(page)).toEqual({ mode: "dark", palette: "nord" });
  expect((await rendered(page)).bg).toBe("#2a303b");
  await page.getByRole("radio", { name: "Green accent" }).click();
  expect((await rendered(page)).accent).toBe(ACCENTS.find((a) => a.id === "green")!.dark.accent);
  await expect(page.getByRole("radio", { name: "Green accent" })).toHaveAttribute("aria-checked", "true");

  // persisted: a new tab in the same profile (without the test's settings seeding) opens in Nord + green, and the
  // pre-paint script has applied it before the app's own code runs
  const tab = await page.context().newPage();
  await tab.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { (window as unknown as { __bgAtDcl: string }).__bgAtDcl = document.documentElement.style.getPropertyValue("--bg"); }));
  await tab.goto("/#/settings");
  await expect(tab.getByRole("radio", { name: "Nord theme" })).toHaveAttribute("aria-checked", "true");
  expect(await tab.evaluate(() => (window as unknown as { __bgAtDcl: string }).__bgAtDcl)).toBe("#2a303b");
  expect((await rendered(tab)).accent).toBe(ACCENTS.find((a) => a.id === "green")!.dark.accent);
  await tab.close();

  // the sidebar's quick toggle switches to the light theme and keeps the chosen accent (its light variant)
  await page.getByRole("button", { name: "Toggle theme" }).click();
  expect(await state(page)).toEqual({ mode: "light", palette: "light" });
  expect((await rendered(page)).accent).toBe(ACCENTS.find((a) => a.id === "green")!.light.accent);

  // System follows the OS, live
  await page.getByRole("radio", { name: "Theme default" }).click();
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("group", { name: "Quick theme" }).getByRole("radio", { name: "System" }).click();
  expect(await state(page)).toEqual({ mode: "light", palette: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => state(page)).toEqual({ mode: "dark", palette: "dark" });
  noErrors(errors);
});

test("every theme × accent meets the WCAG contrast minimums, measured on the rendered page", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await prepare(page);
  await page.goto("/#/settings");
  const fails: string[] = []; let checked = 0;
  for (const t of THEMES) {
    await page.getByRole("radio", { name: `${t.label} theme` }).click();
    for (const a of ACCENTS) {
      await page.getByRole("radio", { name: `${a.label} accent` }).click();
      const v = await rendered(page);
      expect(v.accent, `${t.id}/${a.id}`).toBe(a[t.mode].accent); // the combination really is applied
      for (const c of CONTRAST) { const r = contrastRatio(v[c.fg]!, v[c.bg]!); if (!(r >= c.min)) fails.push(`${t.id}/${a.id}: ${c.fg} on ${c.bg} = ${r.toFixed(2)} < ${c.min}`); }
      checked++;
    }
  }
  expect(checked).toBe(THEMES.length * ACCENTS.length);
  expect(fails).toEqual([]);
  noErrors(errors);
});

test("axe finds no colour-contrast (or other serious) violations in any theme", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await prepare(page);
  const bad: string[] = [];
  for (const t of THEMES) {
    await page.goto("/#/settings");
    await page.getByRole("radio", { name: `${t.label} theme` }).click();
    for (const route of ["", "settings", "chat"]) {
      await page.goto(`/#/${route}`); await page.waitForTimeout(300);
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      for (const v of r.violations.filter((x) => x.impact === "serious" || x.impact === "critical")) bad.push(`${t.id} /${route}: ${v.id} × ${v.nodes.length} (${v.nodes[0]?.html.slice(0, 90)})`);
    }
  }
  expect(bad).toEqual([]);
  noErrors(errors);
});
