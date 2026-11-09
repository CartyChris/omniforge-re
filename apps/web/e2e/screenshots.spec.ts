/** Regenerates the README screenshots (docs/screenshots) from the production build: OMNIFORGE_SCREENSHOTS=1 pnpm exec playwright test e2e/screenshots.spec.ts --project=desktop
 * The analysis is real (fixture site); the chat replies come from a scripted test model. */
import { expect, test, type Route } from "@playwright/test";
import { mockModelSettings, mockProvider, prepare } from "./helpers";
const OUT = new URL("../../../docs/screenshots/", import.meta.url).pathname;
const sse = (route: Route, chunks: unknown[]) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" }, body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n" });
const toolCall = (route: Route, name: string, args: unknown) => sse(route, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${name}_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }]);
const say = (route: Route, text: string) => sse(route, [{ choices: [{ index: 0, delta: { content: text } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]);
test.use({ viewport: { width: 1440, height: 900 } });
test.skip(!process.env.OMNIFORGE_SCREENSHOTS, "set OMNIFORGE_SCREENSHOTS=1 to regenerate the README screenshots");
test("screenshots", async ({ page }) => {
  test.setTimeout(240_000);
  await prepare(page, mockModelSettings);
  await page.addInitScript((p) => { try { localStorage.setItem("omniforge.providers", JSON.stringify(p)); localStorage.setItem("omniforge.ack", "1"); } catch { /* sandboxed frame */ } }, mockProvider);
  let inv = "";
  await page.route("http://127.0.0.1:4599/v1/chat/completions", async (route) => {
    const r = JSON.parse(route.request().postData() ?? "{}"); const sys = r.system ?? String(r.messages.find((m: any) => m.role === "system")?.content ?? "");
    const tools = r.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content));
    if (/a subagent of OmniForge/.test(sys)) return tools.length ? say(route, "Products: Widget and Gadget (product pages /products/widget, /products/gadget). Auth: login form posting to /api/login.") : toolCall(route, "search_investigation", { id: inv, query: "products login form" });
    if (!tools.length) return toolCall(route, "analyze_url", { url: "http://127.0.0.1:4010/", max_pages: 20 });
    if (tools.length === 1) { inv = /Analysis finished: (\S+)/.exec(tools[0])?.[1] ?? ""; return toolCall(route, "delegate", { tasks: [{ role: "reverse", objective: "List the products and how sign-in works" }, { role: "architecture", objective: "Outline a Next.js rebuild" }] }); }
    return say(route, `**What the site is:** a small shop (React) with a product catalogue, a contact form and a sign-in page.\n\n**Observed features**\n- Product catalogue: Widget and Gadget, each with its own page\n- Sign-in: a login form that posts to /api/login\n- Site navigation and a sitemap-only page\n\n**Rebuild plan (Next.js):** app router pages for /, /products, /products/[slug], /about, /contact, /login; a server action for the login form; design tokens taken from the analysis.\n\nEvidence: investigation ${inv}. Say “rebuild it” and I'll plan it with the build agents — you approve before anything is written.`);
  });
  await page.goto("/#/chat");
  await page.getByLabel("Message").fill("Analyse http://127.0.0.1:4010/ — what is it, what features does it have, and how would you rebuild it in Next.js?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/What the site is:/)).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("chat-trace").last().locator("summary").click();
  const clean = async () => { await page.evaluate(() => document.querySelectorAll("[data-sonner-toaster]").forEach((t) => ((t as HTMLElement).style.display = "none"))); };
  await clean(); await page.screenshot({ path: `${OUT}ai-chat.png` });
  await page.goto("/#/");
  await expect(page.getByText("127.0.0.1:4010").first()).toBeVisible();
  await clean(); await page.screenshot({ path: `${OUT}dashboard.png` });
  await page.goto(`/#/investigations/${inv}`);
  await expect(page.getByText("Coverage checks")).toBeVisible();
  await clean(); await page.screenshot({ path: `${OUT}investigation.png` });
  await page.getByRole("tab", { name: /^Graph/ }).click(); await expect(page.locator(".react-flow__node").first()).toBeVisible(); await page.waitForTimeout(800);
  await clean(); await page.screenshot({ path: `${OUT}graph.png` });
});
