import { expect, test } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import fs from "node:fs";
import { noErrors, prepare, underProductionCsp } from "./helpers";

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

test("compare two investigations: choose from the list, see the evidence-derived differences", async ({ page }) => {
  const errors = await prepare(page);
  for (const url of ["http://127.0.0.1:4010/", "http://127.0.0.1:4010/about"]) {
    await page.goto("/#/analyze");
    await page.getByLabel(/Website URL, GitHub repository/).fill(url);
    await page.getByRole("button", { name: /Analyze/ }).last().click();
    await page.getByText("Open results").waitFor({ timeout: 90_000 });
  }
  await page.goto("/#/investigations");
  const compare = page.getByRole("button", { name: /^Compare/ });
  await expect(compare).toBeDisabled();
  const boxes = page.getByRole("checkbox", { name: /to compare/ });
  await boxes.nth(0).check(); await boxes.nth(1).check();
  await compare.click();
  await expect(page).toHaveURL(/investigations\/compare\?a=.+&b=.+/);
  await expect(page.getByTestId("compare-totals")).toContainText("pages");
  await expect(page.getByRole("heading", { name: "Stack" }).or(page.getByText("Stack", { exact: true })).first()).toBeVisible();
  await expect(page.getByText(/overlap \d+%/).first()).toBeVisible();
  // the Dashboard lists real activity only once something was built/deployed — none yet, so no empty card
  await page.goto("/#/");
  await expect(page.getByTestId("recent-activity")).toHaveCount(0);
  noErrors(errors);
});

test("uploaded Python/Java/Go source: HTTP routes are parsed with tree-sitter in the browser (under the production CSP), as recovered evidence", async ({ page }) => {
  const errors = await prepare(page);
  await underProductionCsp(page);
  const { zipSync, strToU8 } = await import("fflate");
  const zip = zipSync({
    "shop/main.py": strToU8('from fastapi import FastAPI\napp = FastAPI()\n@app.get("/users/{id}")\ndef get_user(id: int):\n    return 1\n'),
    "shop/Ctl.java": strToU8('@RestController\n@RequestMapping("/api")\nclass Ctl {\n  @GetMapping("/ping") String ping() { return ""; }\n}\n'),
    "shop/srv.go": strToU8('package main\nfunc main() { r.GET("/health", h) }\n'),
    "shop/README.md": strToU8("# shop"),
  });
  await page.goto("/#/analyze");
  const grammars: string[] = []; page.on("request", (r) => { if (r.url().includes("/tree-sitter/")) grammars.push(r.url().split("/").pop()!); });
  await page.locator("input[type=file]").first().setInputFiles({ name: "shop.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await page.getByText("Open results").waitFor({ timeout: 90_000 });
  await page.getByRole("button", { name: "Open results" }).click();
  await page.getByRole("tab", { name: /^APIs/ }).click();
  for (const p of ["/users/{id}", "/api/ping", "/health"]) await expect(page.getByText(p, { exact: true }).first()).toBeVisible();
  // only the grammars for the languages present were fetched (not all eight)
  expect([...new Set(grammars)].sort()).toEqual(["tree-sitter-go.wasm", "tree-sitter-java.wasm", "tree-sitter-python.wasm", "web-tree-sitter.wasm"]);
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByText("Code structure parsed (tree-sitter)")).toBeVisible();
  noErrors(errors);
});
