import { expect, test } from "@playwright/test";
import { noErrors, prepare, underProductionCsp } from "./helpers";

test("Sign in with OpenRouter (web): PKCE redirect, code exchange, key stored, models discovered, code removed from the URL", async ({ page }) => {
  const errors = await prepare(page);
  await underProductionCsp(page);
  let challenge = ""; let exchange: any; let modelAuth = "";
  await page.route("https://openrouter.ai/auth?**", async (route) => {
    const u = new URL(route.request().url()); challenge = u.searchParams.get("code_challenge") ?? "";
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    await route.fulfill({ status: 302, headers: { location: `${u.searchParams.get("callback_url")}?code=test-code-123` } });
  });
  await page.route("https://openrouter.ai/api/v1/auth/keys", async (route) => { exchange = JSON.parse(route.request().postData() ?? "{}"); await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ key: "sk-or-v1-from-oauth" }) }); });
  await page.route("https://openrouter.ai/api/v1/models", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });
    modelAuth = route.request().headers()["authorization"] ?? "";
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ data: [{ id: "openai/gpt-x", name: "GPT X", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools"] }, { id: "anthropic/claude-y", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } }] }) });
  });
  await page.goto("/#/studio?tab=providers");
  await page.getByRole("button", { name: "Add provider" }).click();
  await page.getByRole("button", { name: /^OpenRouter/ }).click();
  await page.getByRole("button", { name: "Sign in with OpenRouter" }).click();
  await expect(page.getByText(/Signed in to OpenRouter/)).toBeVisible({ timeout: 20_000 });
  expect(exchange).toMatchObject({ code: "test-code-123", code_challenge_method: "S256" });
  const digest = await page.evaluate(async (v) => { const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))); let s = ""; for (const b of d) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }, exchange.code_verifier);
  expect(digest).toBe(challenge);
  expect(page.url()).not.toContain("code=");
  await expect.poll(() => modelAuth, { timeout: 20_000 }).toBe("Bearer sk-or-v1-from-oauth");
  await page.goto("/#/studio?tab=models");
  await expect(page.getByText("anthropic/claude-y").first()).toBeVisible({ timeout: 20_000 });
  noErrors(errors);
});
