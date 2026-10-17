import { chromium, devices } from "@playwright/test";
const out = process.argv[2]; const desktop = process.argv[3] === "desktop";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const ctx = await b.newContext(desktop ? { viewport: { width: 1440, height: 900 } } : { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } });
const page = await ctx.newPage(); const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push(`console: ${m.text().slice(0, 200)}`); });
await page.addInitScript(() => { try { localStorage.setItem("omniforge.settings", JSON.stringify({ onboarded: true })); localStorage.setItem("omniforge.ack", "1"); } catch {} });
const routes = ["", "analyze", "repo-rip", "investigations", "applications", "features", "studio", "workspace", "models", "integrations", "deployments", "settings"];
for (const r of routes) {
  await page.goto(`http://127.0.0.1:5173/#/${r}`, { waitUntil: "networkidle" }); await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const h1 = await page.locator("h1").first().textContent().catch(() => null);
  console.log(`${r || "dashboard"}: h1=${JSON.stringify(h1)} ${overflow ? "HORIZONTAL OVERFLOW" : "ok"}`);
  await page.screenshot({ path: `${out}-${r || "dashboard"}.png` });
}
console.log(errs.length ? "ERRORS:\n" + errs.join("\n") : "no console errors");
await b.close();
