import { expect, type Page } from "@playwright/test";

/** Skip onboarding + the one-time authorised-use dialog, and collect console/page errors for assertion. */
export async function prepare(page: Page, extra: Record<string, unknown> = {}) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") { const l = m.location(); errors.push(`console: ${m.text().slice(0, 250)}${l?.url ? ` @ ${l.url}:${l.lineNumber}` : ""}`); } });
  await page.addInitScript((s) => { try { localStorage.setItem("omniforge.settings", JSON.stringify({ onboarded: true, ...s })); localStorage.setItem("omniforge.ack", "1"); } catch { /* sandboxed iframes have no storage */ } }, extra);
  return errors;
}
export const noErrors = (errors: string[]) => expect(errors, errors.join("\n")).toEqual([]);

/** The scripted mock model + providers/routing preseeded so every task kind uses it (the real Claude CLI may exist on a dev machine). */
export const mockModelSettings = { assignments: Object.fromEntries(["classify", "extract", "summarize", "architecture", "code", "review", "vision", "embed", "research", "test"].map((k) => [k, "mock::mock-scripted-coder"])) };
export const mockProvider = [{ id: "mock", label: "Scripted mock model", kind: "openai-compat", preset: "custom", baseUrl: "http://127.0.0.1:4599/v1", local: true, enabled: true }];
