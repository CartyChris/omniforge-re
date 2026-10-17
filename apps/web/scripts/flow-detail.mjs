import { chromium } from "@playwright/test";
const out = process.argv[2];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200)); });
await page.addInitScript(() => { try { localStorage.setItem("omniforge.settings", JSON.stringify({ onboarded: true })); localStorage.setItem("omniforge.ack", "1"); } catch {} });
await page.goto("http://127.0.0.1:5173/#/analyze", { waitUntil: "networkidle" });
await page.getByLabel(/Website URL, GitHub repository/).fill("http://127.0.0.1:4010/");
await page.getByRole("button", { name: /Analyze/ }).last().click();
await page.waitForSelector("text=Open results", { timeout: 90000 });
await page.getByText("Open results").click();
await page.waitForSelector("text=Coverage checks");
await page.waitForTimeout(600);
await page.screenshot({ path: out + "-overview.png", fullPage: false });
for (const t of ["Stack", "Features", "Graph", "Findings", "Evidence", "Report", "Files", "APIs", "Pages"]) {
  const tab = page.getByRole("tab", { name: new RegExp("^" + t) });
  if (await tab.count()) { await tab.first().click(); await page.waitForTimeout(t === "Graph" || t === "Report" ? 1500 : 500); await page.screenshot({ path: `${out}-${t.toLowerCase()}.png` }); }
  else console.log("no tab", t);
}
// evidence drawer
await page.getByRole("tab", { name: /^Evidence/ }).click();
await page.locator("ul li button").first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: out + "-evidence-drawer.png" });
await page.keyboard.press("Escape"); await page.getByRole("tab", { name: /^Ask AI/ }).click(); await page.waitForTimeout(400); await page.screenshot({ path: out + "-ask.png" });
await page.goto("http://127.0.0.1:5173/#/investigations"); await page.waitForTimeout(500); await page.screenshot({ path: out + "-list.png" });
await page.goto("http://127.0.0.1:5173/#/investigations"); await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(500); await page.screenshot({ path: out + "-list-mobile.png" });
await page.locator("a[href*='investigations/']").first().click(); await page.waitForTimeout(800); await page.screenshot({ path: out + "-detail-mobile.png" });
console.log(errs.length ? errs.join("\n") : "no console errors");
await b.close();
