import { expect, test } from "@playwright/test";
import { mockModelSettings, mockProvider, noErrors, prepare } from "./helpers";

test("Ask AI sends the passages that match the question (retrieval), not only a fixed overview", async ({ page }) => {
  const errors = await prepare(page, mockModelSettings);
  await page.addInitScript((p) => { try { localStorage.setItem("omniforge.providers", JSON.stringify(p)); } catch { /* sandboxed frame */ } }, mockProvider);
  const prompts: string[] = [];
  await page.route("http://127.0.0.1:4599/v1/chat/completions", async (route) => { try { const b = JSON.parse(route.request().postData() ?? "{}"); prompts.push((b.messages ?? []).map((m: { content: unknown }) => String(m.content)).join("\n")); } catch { /* ignore */ } await route.continue(); });

  await page.goto("/#/analyze");
  await page.getByLabel(/Website URL, GitHub repository/).fill("http://127.0.0.1:4010/");
  await page.getByRole("button", { name: /Analyze/ }).last().click();
  await page.getByText("Open results").waitFor({ timeout: 90_000 });
  await page.getByRole("button", { name: "Open results" }).click();
  await page.getByRole("tab", { name: /^Ask AI/ }).click();
  await page.getByLabel("Question").fill("Which product page opens a dialog?");
  await page.getByLabel("Question").press("Enter");
  await expect.poll(() => prompts.find((p) => p.includes("Which product page opens a dialog?")) ?? "", { timeout: 60_000 }).toContain("Passages retrieved for this question");
  const sent = prompts.find((p) => p.includes("Which product page opens a dialog?"))!;
  const passages = sent.slice(sent.indexOf("Passages retrieved for this question"), sent.indexOf("evidence-ledger"));
  expect(passages).toContain("page: /products/gadget"); // the page whose copy answers it
  expect(passages).toContain('label="retrieved-passages"'); // fenced as untrusted like every other site-derived block
  await expect(page.getByText(/AI-generated · mock\//)).toBeVisible({ timeout: 60_000 });
  noErrors(errors);
});
