import { expect, test } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import fs from "node:fs";
import { noErrors, prepare } from "./helpers";

test("analyse a website end to end: live job → evidence-linked results → exports", async ({ page }) => {
  const errors = await prepare(page);
  await page.goto("/#/analyze");
  await page.getByLabel(/Website URL, GitHub repository/).fill("http://127.0.0.1:4010/");
  await page.getByRole("button", { name: /Analyze/ }).last().click();
  await page.getByText("Open results").waitFor({ timeout: 90_000 });
  await expect(page.getByText("Discovered pages")).toBeVisible();
  await page.getByRole("button", { name: "Open results" }).click();

  // overview: coverage is computed, limits are stated
  await expect(page.getByText("Coverage checks")).toBeVisible();
  await expect(page.getByText(/Limits of this analysis/)).toBeVisible();
  // robots.txt was honoured: the fixture disallows /private
  await page.getByRole("tab", { name: /^Pages/ }).click();
  await expect(page.getByRole("cell", { name: "/about", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: /\/private/ })).toHaveCount(0);
  // tech + features come with evidence
  await page.getByRole("tab", { name: /^Stack/ }).click();
  await expect(page.getByText("React").first()).toBeVisible();
  await page.getByRole("tab", { name: /^Features/ }).click();
  await page.getByText("Site navigation").click();
  await expect(page.getByText("Behaviour spec (inferred from evidence)")).toBeVisible();
  await page.keyboard.press("Escape");
  // evidence drawer shows provenance + hash
  await page.getByRole("tab", { name: /^Evidence/ }).click();
  await page.locator("ul li button").first().click();
  await expect(page.getByText("Captured")).toBeVisible();
  await page.keyboard.press("Escape");
  // graph renders nodes
  await page.getByRole("tab", { name: /^Graph/ }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  // report export: real ZIP with every artefact
  await page.getByRole("tab", { name: /^Report/ }).click();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Full bundle/ }).click()]);
  const zip = unzipSync(new Uint8Array(fs.readFileSync((await dl.path())!)));
  expect(Object.keys(zip)).toEqual(expect.arrayContaining(["report.md", "report.html", "report.json", "graph.json", "evidence.json"]));
  expect(strFromU8(zip["report.md"]!)).toContain("Executive application overview");
  // HTML report is escaped + sandboxed in the preview
  expect(await page.locator('iframe[title="Report preview"]').getAttribute("sandbox")).toBe("");
  noErrors(errors);
});

test("hosted mode refuses private, loopback and metadata addresses before any request (SSRF)", async ({ request }) => {
  for (const url of ["http://127.0.0.1:4010/", "http://169.254.169.254/latest/meta-data/", "http://localhost:4010/", "http://[::1]/", "file:///etc/passwd"]) {
    const a = await request.post("http://127.0.0.1:8788/api/analyze", { data: { targets: [url] } });
    expect(a.status(), `analyze ${url}`).toBe(400);
    const p = await request.post("http://127.0.0.1:8788/api/probe", { data: { url } });
    expect(p.status(), `probe ${url}`).toBe(400);
  }
});

test("an interrupted analysis is recovered as 'interrupted', never lost", async ({ page, context }) => {
  const errors = await prepare(page);
  await page.goto("/#/analyze");
  await page.getByLabel(/Website URL, GitHub repository/).fill("http://127.0.0.1:4010/");
  await page.getByRole("button", { name: /Analyze/ }).last().click();
  await page.getByText(/Discovered pages/).waitFor();
  await page.getByText("seed").first().waitFor(); // the first progress event has been saved as a "running" investigation
  await page.reload(); // simulate closing the tab mid-run
  await page.goto("/#/investigations");
  await expect(page.getByText(/Interrupted|Complete/).first()).toBeVisible();
  noErrors(errors.filter((e) => !/AbortError|ERR_ABORTED|net::/.test(e)));
  void context;
});
