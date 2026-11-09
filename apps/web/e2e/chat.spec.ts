import { expect, test, type Route } from "@playwright/test";
import { mockModelSettings, mockProvider, noErrors, prepare } from "./helpers";

type Req = { system: string; messages: { role: string; content: string; tool_call_id?: string }[]; tools?: { function: { name: string } }[] };
const sse = (route: Route, chunks: unknown[]) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" }, body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n" });
const toolCall = (route: Route, name: string, args: unknown) => sse(route, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${name}_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
const say = (route: Route, text: string) => sse(route, [{ choices: [{ index: 0, delta: { content: text } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
const sysText = (r: Req) => r.system ?? String(r.messages.find((m) => m.role === "system")?.content ?? "");

test("AI Chat orchestrator: analyses a site, delegates to a subagent, answers from the evidence; conversation is kept", async ({ page }) => {
  const errors = await prepare(page, mockModelSettings);
  await page.addInitScript((p) => { try { localStorage.setItem("omniforge.providers", JSON.stringify(p)); localStorage.setItem("omniforge.ack", "1"); } catch { /* sandboxed frame */ } }, mockProvider);
  const seen: Req[] = []; let invId = "";
  await page.route("http://127.0.0.1:4599/v1/chat/completions", async (route) => {
    const r = JSON.parse(route.request().postData() ?? "{}") as Req; seen.push(r);
    const tools = r.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    if (/a subagent of OmniForge/.test(sysText(r))) return tools.length ? say(route, "Subagent report: the catalogue lists Widget and Gadget.") : toolCall(route, "search_investigation", { id: invId, query: "products widget gadget" });
    if (!tools.length) return toolCall(route, "analyze_url", { url: "http://127.0.0.1:4010/", max_pages: 12 });
    if (tools.length === 1) { invId = /Analysis finished: (\S+)/.exec(tools[0]!)?.[1] ?? ""; return toolCall(route, "delegate", { tasks: [{ role: "reverse", objective: "Which products does the analysed site sell?" }] }); }
    return say(route, `The site sells Widget and Gadget (investigation ${invId}).`);
  });

  await page.goto("/#/chat");
  await expect(page.getByRole("radio", { name: "Orchestrator" })).toHaveAttribute("aria-checked", "true");
  await page.getByLabel("Message").fill("What does http://127.0.0.1:4010/ sell?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/The site sells Widget and Gadget \(investigation /)).toBeVisible({ timeout: 90_000 });
  expect(invId).toMatch(/\S/);

  // the trace shows the real steps, all finished
  const trace = page.getByTestId("chat-trace").last(); await trace.locator("summary").click();
  await expect(trace).toContainText("analyze_url"); await expect(trace).toContainText("sub1 · reverse"); await expect(trace).toContainText("sub1 · search_investigation");
  await expect(trace.getByLabel("failed")).toHaveCount(0);
  // the orchestrator offered its tools; the subagent got the analysis tools but not delegate/rebuild
  const main = seen.find((r) => !/a subagent of OmniForge/.test(sysText(r)))!; const sub = seen.find((r) => /a subagent of OmniForge/.test(sysText(r)))!;
  expect(main.tools!.map((t) => t.function.name)).toEqual(expect.arrayContaining(["analyze_url", "delegate", "rebuild_app", "search_investigation"]));
  expect(sub.tools!.map((t) => t.function.name)).not.toContain("delegate"); expect(sub.tools!.map((t) => t.function.name)).not.toContain("rebuild_app");
  // site-derived content reached the model fenced
  const analysed = main && seen.map((r) => r.messages.filter((m) => m.role === "tool").map((m) => String(m.content))).flat().find((t) => t.startsWith("Analysis finished"))!;
  expect(analysed).toContain("<<<UNTRUSTED_DATA"); expect(analysed).toContain("/products");

  // the analysis is a real investigation, and the conversation survives a reload
  await page.goto("/#/investigations"); await expect(page.getByText("127.0.0.1:4010").first()).toBeVisible();
  await page.goto("/#/chat"); await expect(page.getByText(/The site sells Widget and Gadget/)).toBeVisible();
  await expect(page.getByRole("button", { name: "What does http://127.0.0.1:4010/ sell?", exact: true })).toBeVisible();
  noErrors(errors);
});

test("AI Chat single model: attached text is sent fenced as untrusted, without tools", async ({ page }) => {
  const errors = await prepare(page, mockModelSettings);
  await page.addInitScript((p) => { try { localStorage.setItem("omniforge.providers", JSON.stringify(p)); } catch { /* sandboxed frame */ } }, mockProvider);
  let body: Req | undefined;
  await page.route("http://127.0.0.1:4599/v1/chat/completions", async (route) => { body = JSON.parse(route.request().postData() ?? "{}"); return say(route, "It calls the cart API."); });
  await page.goto("/#/chat");
  await page.getByRole("radio", { name: "Single model" }).click();
  await page.locator('input[type="file"][aria-label="Attach files"]').setInputFiles({ name: "app.js", mimeType: "text/javascript", buffer: Buffer.from("fetch('/api/cart')") });
  await expect(page.getByLabel("Attached files")).toContainText("app.js");
  await page.getByLabel("Message").fill("What does this do?"); await page.getByLabel("Message").press("Enter");
  await expect(page.getByText("It calls the cart API.")).toBeVisible({ timeout: 30_000 });
  const last = String(body!.messages.at(-1)!.content);
  expect(last).toMatch(/^<<<UNTRUSTED_DATA label="attachment:app.js"/); expect(last).toContain("fetch('/api/cart')"); expect(last.endsWith("What does this do?")).toBe(true);
  expect(body!.tools).toBeUndefined();
  await expect(page.getByLabel("Attached files")).toHaveCount(0); // cleared after sending
  noErrors(errors);
});
