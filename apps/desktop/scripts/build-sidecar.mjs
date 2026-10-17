#!/usr/bin/env node
/**
 * Compiles the local engine (packages/server) into a standalone binary per target triple, and copies playwright-core
 * next to the app as a resource (the engine loads it lazily for the optional rendered-page mode).
 *
 *   node scripts/build-sidecar.mjs            # arm64 + x64 macOS
 *   node scripts/build-sidecar.mjs --host     # only the machine you're on (for `tauri dev`)
 *   node scripts/build-sidecar.mjs --target aarch64-apple-darwin
 *
 * Bun cross-compiles, so this works from Linux CI too; the binaries are verified by `file`/magic number below.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const bins = path.join(here, "../src-tauri/binaries");
const res = path.join(here, "../src-tauri/resources");
const TARGETS = { "aarch64-apple-darwin": "bun-darwin-arm64", "x86_64-apple-darwin": "bun-darwin-x64", "x86_64-unknown-linux-gnu": "bun-linux-x64", "aarch64-unknown-linux-gnu": "bun-linux-arm64" };
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const hostTriple = () => { const a = os.arch() === "arm64" ? "aarch64" : "x86_64"; return os.platform() === "darwin" ? `${a}-apple-darwin` : `${a}-unknown-linux-gnu`; };
const wanted = process.argv.includes("--host") ? [hostTriple()] : arg("target") ? [arg("target")] : ["aarch64-apple-darwin", "x86_64-apple-darwin"];

fs.mkdirSync(bins, { recursive: true });
for (const triple of wanted) {
  const bunTarget = TARGETS[triple]; if (!bunTarget) throw new Error(`Unsupported target ${triple}`);
  const out = path.join(bins, `omniforge-bridge-${triple}`);
  console.log(`▶ compiling engine for ${triple}`);
  execFileSync("bun", ["build", "--compile", `--target=${bunTarget}`, "--minify", path.join(root, "packages/server/src/main.ts"), "--outfile", out], { stdio: "inherit", cwd: root });
  // verify the artefact really is the right kind of executable (cannot run a macOS binary on Linux, but we can check its header)
  const magic = fs.readFileSync(out).subarray(0, 4).toString("hex");
  const expect = triple.includes("darwin") ? ["cffaedfe", "cafebabe"] : ["7f454c46"]; // Mach-O 64 LE / universal, ELF
  if (!expect.includes(magic)) throw new Error(`${out}: unexpected file header ${magic}`);
  fs.chmodSync(out, 0o755);
  console.log(`  ✓ ${path.relative(root, out)} (${(fs.statSync(out).size / 1e6).toFixed(0)} MB, header ${magic})`);
}

// playwright-core as a plain resource folder
const require = createRequire(path.join(root, "packages/server/package.json"));
const pwDir = path.dirname(require.resolve("playwright-core/package.json"));
const dest = path.join(res, "playwright-core");
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(pwDir, dest, { recursive: true, dereference: true, filter: (s) => !/[\\/](?:\.bin|\.cache)(?:[\\/]|$)/.test(s) });
console.log(`  ✓ playwright-core ${JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8")).version} → ${path.relative(root, dest)}`);
