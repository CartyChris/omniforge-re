#!/usr/bin/env node
/**
 * Produces a Vercel "Build Output API v3" directory:
 *   .vercel/output/static            the built web app
 *   .vercel/output/functions/api/*   the portable handlers, each bundled with esbuild into ONE self-contained file
 *   .vercel/output/config.json       routes + security headers
 * Run from the repository root by Vercel (`vercel.json` → buildCommand) or locally: `node apps/web/scripts/build-api.mjs`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { CSP as csp } from "./csp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const out = path.join(root, ".vercel/output");
fs.rmSync(out, { recursive: true, force: true });

console.log("▶ building the web app");
execFileSync("pnpm", ["--filter", "@omniforge/web", "build:ui"], { stdio: "inherit", cwd: root });
fs.cpSync(path.join(root, "apps/web/dist"), path.join(out, "static"), { recursive: true });

const FUNCTIONS = { "api/analyze": ["analyze", 300], "api/repo/inspect": ["repo-inspect", 60], "api/repo/files": ["repo-files", 120], "api/forward": ["forward", 300], "api/probe": ["probe", 30], "api/health": ["health", 10] };
for (const [route, [entry, maxDuration]] of Object.entries(FUNCTIONS)) {
  const dir = path.join(out, "functions", `${route}.func`);
  console.log(`▶ bundling /${route}`);
  await build({
    entryPoints: [path.join(root, `packages/server/src/vercel/${entry}.ts`)], outfile: path.join(dir, "index.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", minify: true, legalComments: "none", sourcemap: false,
    // CJS packages bundled into ESM need require()
    banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
    logLevel: "warning",
  });
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dir, ".vc-config.json"), JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", supportsResponseStreaming: true, maxDuration, shouldAddHelpers: false, shouldAddSourcemapSupport: false }, null, 2));
}

fs.writeFileSync(path.join(out, "config.json"), JSON.stringify({
  version: 3,
  routes: [
    { src: "/(.*)", headers: { "content-security-policy": csp, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "permissions-policy": "camera=(), microphone=(), geolocation=()", "strict-transport-security": "max-age=63072000; includeSubDomains" }, continue: true },
    { src: "/assets/(.*)", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
    { src: "/api/(.*)", headers: { "cache-control": "no-store" }, continue: true },
    { handle: "filesystem" },
    { src: "/api/(.*)", status: 404 },
  ],
}, null, 2));
const size = (d) => execFileSync("du", ["-sh", d]).toString().split("\t")[0];
console.log(`✓ .vercel/output ready — static ${size(path.join(out, "static"))}, functions ${size(path.join(out, "functions"))}`);
