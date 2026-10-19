import { expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { mockModelSettings, mockProvider, noErrors, prepare } from "./helpers";

const SKILL = "---\nname: house-style\ndescription: Our house style for React components.\n---\nUse named exports only.\n";

test("Agent Skills: built-ins listed, a zip skill imported, a skill disabled — and Build agents see exactly the enabled ones", async ({ page }) => {
  const errors = await prepare(page, mockModelSettings);
  await page.addInitScript((p) => { try { localStorage.setItem("omniforge.providers", JSON.stringify(p)); } catch { /* sandboxed frame */ } }, mockProvider);
  const systems: string[] = [];
  await page.route("http://127.0.0.1:4599/v1/chat/completions", async (route) => { try { const b = JSON.parse(route.request().postData() ?? "{}"); const s = (b.messages ?? []).find((m: { role: string }) => m.role === "system"); if (s) systems.push(String(s.content)); } catch { /* ignore */ } await route.continue(); });

  await page.goto("/#/studio?tab=skills");
  const list = page.getByTestId("skills-list");
  for (const n of ["faithful-rebuild", "accessible-ui", "tests-that-can-fail", "secure-defaults"]) await expect(list.getByRole("button", { name: n, exact: true })).toBeVisible();
  // import: a valid skill and a broken one in one archive
  const zip = Buffer.from(zipSync({ "house-style/SKILL.md": strToU8(SKILL), "house-style/references/naming.md": strToU8("PascalCase"), "broken/SKILL.md": strToU8("no front matter") }));
  await page.getByLabel("Skill archive or SKILL.md").setInputFiles({ name: "skills.zip", mimeType: "application/zip", buffer: zip });
  await expect(list.getByRole("button", { name: "house-style", exact: true })).toBeVisible();
  await expect(page.getByTestId("skill-problems")).toContainText("front matter");
  await list.getByRole("button", { name: "house-style", exact: true }).click();
  await expect(page.getByLabel("Skill instructions")).toContainText("Use named exports only."); await page.keyboard.press("Escape");
  await page.getByRole("switch", { name: "Enable skill secure-defaults" }).click();
  await expect(page.getByRole("switch", { name: "Enable skill secure-defaults" })).not.toBeChecked();
  // survives a reload
  await page.reload(); await expect(page.getByRole("switch", { name: "Enable skill secure-defaults" })).not.toBeChecked(); await expect(list.getByRole("button", { name: "house-style", exact: true })).toBeVisible();

  await page.goto("/#/studio?tab=build");
  await page.getByRole("radio", { name: /Build from scratch/ }).click();
  await page.getByLabel(/Describe the app/).fill("A tiny notes app");
  await page.getByRole("button", { name: "Generate plan" }).click();
  await page.getByRole("button", { name: "Run plan" }).click();
  await expect.poll(() => systems.find((s) => s.includes("SKILLS")) ?? "", { timeout: 60_000 }).toContain("- house-style: Our house style for React components.");
  const sys = systems.find((s) => s.includes("SKILLS"))!;
  expect(sys).toContain("- faithful-rebuild:"); expect(sys).not.toContain("- secure-defaults:"); expect(sys).not.toContain("Use named exports only."); // bodies load on demand
  await page.getByRole("button", { name: "Stop" }).click({ timeout: 2_000 }).catch(() => {}); // the run may already have finished
  noErrors(errors);
});
