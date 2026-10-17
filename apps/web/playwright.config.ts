import fs from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against the PRODUCTION build (vite preview) with the same portable API handlers the Vercel
 * functions use, a fixture website, a scripted mock model, and a real desktop engine ("bridge") process.
 */
// A pre-installed Chromium (sandboxes) wins; otherwise Playwright's own download is used (CI).
const executablePath = process.env.CHROME_PATH ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const launchOptions = { executablePath, args: ["--no-sandbox"] };

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure", screenshot: "only-on-failure", launchOptions, acceptDownloads: true },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], launchOptions }, testMatch: /routes\.spec\.ts/ },
  ],
  webServer: [
    { command: "node ../../fixtures/server.mjs", url: "http://127.0.0.1:4010/", env: { PORT: "4010" }, reuseExistingServer: true },
    { command: "node ../../fixtures/mock-llm.mjs", url: "http://127.0.0.1:4599/v1/models", env: { PORT: "4599" }, reuseExistingServer: true },
    { command: "pnpm exec tsx ../../packages/server/src/dev.ts", url: "http://127.0.0.1:8787/api/health", env: { PORT: "8787", OMNIFORGE_DEV_LOCAL: "1" }, reuseExistingServer: true },
    { command: "pnpm exec tsx ../../packages/server/src/dev.ts", url: "http://127.0.0.1:8788/api/health", env: { PORT: "8788" }, reuseExistingServer: true }, // hosted mode (strict)
    { command: "pnpm exec tsx ../../packages/server/src/main.ts --no-stdin-watch", url: "http://127.0.0.1:4466/bridge/health", env: { OMNIFORGE_BRIDGE_PORT: "4466", OMNIFORGE_UI_TOKEN: "ui-token-for-e2e-0123456789abcdef", OMNIFORGE_ALLOWED_ORIGINS: "http://127.0.0.1:5173", OMNIFORGE_LOCAL_PORTS: "4599", OMNIFORGE_HOME: "/tmp/omniforge-e2e-home" }, reuseExistingServer: true },
    { command: "pnpm build:ui && pnpm exec vite preview --host 127.0.0.1", url: "http://127.0.0.1:5173/", reuseExistingServer: true, timeout: 240_000 },
  ],
});
