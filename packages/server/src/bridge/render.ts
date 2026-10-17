/**
 * Headless-browser analysis (Playwright) for the desktop/local worker: executes
 * the page's JavaScript, records network calls, captures a screenshot, and
 * performs a bounded set of SAFE interactions (open tabs/menus/accordions,
 * scroll). It never submits forms, never clicks links/buttons whose label looks
 * destructive, never downloads files, and every request is checked against the
 * same SSRF policy as the crawler.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";
import { privateIpReason, validateUrl, type RenderResult, type Renderer } from "@omniforge/core";
import { which } from "./detect.js";

/**
 * Playwright is loaded lazily and by a non-literal specifier so the bridge can be compiled into a single binary
 * (the desktop app ships playwright-core as a resource folder and points OMNIFORGE_PLAYWRIGHT at it).
 */
async function loadPlaywright(): Promise<typeof import("playwright-core")> {
  const dir = process.env.OMNIFORGE_PLAYWRIGHT;
  const spec = dir ? pathToFileURL(path.join(dir, "index.mjs")).href : "playwright-core";
  try { return (await import(spec)) as typeof import("playwright-core"); }
  catch (e) { throw new Error(`The page renderer (playwright-core) could not be loaded: ${(e as Error).message}`); }
}

export function findChrome(): string | null {
  const env = process.env.OMNIFORGE_CHROME ?? process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const candidates = [
    pw && path.join(pw, "chromium"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", which("google-chrome") ?? "", which("chromium") ?? "",
  ].filter(Boolean) as string[];
  return candidates.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) ?? null;
}

const DESTRUCTIVE = /\b(delete|remove|destroy|erase|reset|logout|log out|sign out|signout|buy|purchase|pay|checkout|order|subscribe|submit|send|post|publish|confirm|unsubscribe|cancel (?:subscription|account)|deactivate|close account|transfer|withdraw)\b/i;

export interface RendererOptions { executablePath?: string; allowPrivate?: boolean; maxInteractions?: number; navTimeoutMs?: number; screenshot?: boolean }

export class PlaywrightRenderer implements Renderer {
  private browser: Browser | null = null;
  constructor(private o: RendererOptions = {}) {}

  async start() {
    if (this.browser) return;
    const exe = this.o.executablePath ?? findChrome();
    if (!exe) throw new Error("No Chrome/Chromium found. Install Google Chrome or set OMNIFORGE_CHROME to a Chrome-family executable.");
    const { chromium } = await loadPlaywright();
    this.browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--mute-audio"] });
  }
  async close() { await this.browser?.close().catch(() => {}); this.browser = null; }

  async render(url: string, o: { signal?: AbortSignal; interact: boolean; scopeCheck: (u: string) => boolean }): Promise<RenderResult> {
    await this.start();
    const ctx = await this.browser!.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: "block", javaScriptEnabled: true, permissions: [], userAgent: undefined, locale: "en-US" });
    const requests: RenderResult["requests"] = [];
    const consoleErrors: string[] = [];
    const interactions: RenderResult["interactions"] = [];
    const allowPrivate = !!this.o.allowPrivate;
    // SSRF policy for EVERY request the page makes (subresources, XHR, redirects)
    await ctx.route("**/*", async (route) => {
      const u = route.request().url();
      try {
        if (!/^https?:/i.test(u)) return route.continue(); // data:, blob:, about:
        validateUrl(u, { allowPrivate });
        return route.continue();
      } catch {
        requests.push({ url: u, method: route.request().method(), resourceType: "blocked" });
        return route.abort("blockedbyclient");
      }
    });
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error" && consoleErrors.length < 20) consoleErrors.push(m.text().slice(0, 300)); });
    page.on("pageerror", (e) => { if (consoleErrors.length < 20) consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`); });
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    page.on("download", (d) => d.cancel().catch(() => {}));
    page.on("response", (r) => { const rq = r.request(); const t = rq.resourceType(); if (requests.length < 800 && !["media"].includes(t)) requests.push({ url: r.url(), method: rq.method(), resourceType: t, status: r.status() }); });
    const abort = () => ctx.close().catch(() => {});
    o.signal?.addEventListener("abort", abort, { once: true });
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: this.o.navTimeoutMs ?? 30_000 }).catch(async () => { await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {}); });
      // verify we did not get redirected out of scope or onto a private host
      const finalUrl = page.url();
      if (!o.scopeCheck(finalUrl) && finalUrl !== "about:blank") throw new Error(`Navigation left the permitted scope: ${finalUrl}`);
      if (o.interact) await this.interact(page, interactions, o.scopeCheck, this.o.maxInteractions ?? 12);
      let screenshot: string | undefined;
      if (this.o.screenshot !== false) screenshot = `data:image/jpeg;base64,${(await page.screenshot({ type: "jpeg", quality: 60, fullPage: false })).toString("base64")}`;
      const html = await page.content();
      return { html, finalUrl, requests, consoleErrors, interactions, screenshot, title: await page.title().catch(() => "") };
    } finally {
      o.signal?.removeEventListener("abort", abort);
      await ctx.close().catch(() => {});
    }
  }

  private async interact(page: Page, out: RenderResult["interactions"], scopeCheck: (u: string) => boolean, max: number) {
    const before = async () => page.evaluate(() => ({ dialogs: document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]').length, expanded: document.querySelectorAll('[aria-expanded="true"]').length, text: document.body.innerText.length, url: location.href }));
    // 1. lazy-load / infinite scroll (bounded)
    for (let i = 0; i < 4; i++) {
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.evaluate((y) => window.scrollTo(0, y), h);
      await page.waitForTimeout(250);
      const h2 = await page.evaluate(() => document.documentElement.scrollHeight);
      if (h2 === h) break;
      out.push({ action: "scroll", target: "page bottom", effect: `page grew ${h} → ${h2}px (lazy content loaded)` });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    // 2. safe disclosure controls only
    const sel = '[role="tab"], summary, [aria-haspopup]:not(a), [aria-expanded="false"]:not(a), button[data-state="closed"]';
    const handles = (await page.$$(sel)).slice(0, max);
    for (const h of handles) {
      try {
        const info = await h.evaluate((el) => ({ label: ((el as HTMLElement).innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.tagName).trim().slice(0, 60), tag: el.tagName.toLowerCase(), inForm: !!el.closest("form"), isSubmit: !!el.closest("form") && (el as HTMLButtonElement).type === "submit", visible: !!((el as HTMLElement).offsetWidth || (el as HTMLElement).offsetHeight) }));
        if (!info.visible || info.isSubmit || DESTRUCTIVE.test(info.label)) continue;
        const b = await before();
        await h.click({ timeout: 1500, trial: false });
        await page.waitForTimeout(200);
        const a = await before();
        if (!scopeCheck(a.url)) { await page.goBack().catch(() => {}); out.push({ action: "click", target: info.label, effect: "navigated out of scope; returned" }); continue; }
        const effects = [a.dialogs > b.dialogs ? `opened ${a.dialogs - b.dialogs} dialog(s)` : "", a.expanded !== b.expanded ? `aria-expanded ${b.expanded}→${a.expanded}` : "", Math.abs(a.text - b.text) > 20 ? `text length ${b.text}→${a.text}` : "", a.url !== b.url ? `URL → ${new URL(a.url).pathname}` : ""].filter(Boolean);
        out.push({ action: "click", target: `${info.tag} “${info.label}”`, effect: effects.join("; ") || "no observable change" });
        await page.keyboard.press("Escape").catch(() => {});
      } catch { /* element detached or not clickable; skip */ }
    }
  }
}
