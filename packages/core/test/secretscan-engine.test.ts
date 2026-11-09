/**
 * The Rust/WebAssembly secret-scan engine (native/secretscan) against the JS reference: identical candidates and identical
 * redaction on real code, planted secrets, non-ASCII text and fuzz; the embedded build matches the crate sources; and it is faster.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findLeaks, jsCandidates, setSecretScanEngine, type Candidate } from "../src/util/gitleaks";
import { createWasmSecretScan, utf8ToUtf16 } from "../src/util/secretscan";
import { SECRETSCAN_SOURCE_SHA256, installNativeSecretScan, secretScanWasm } from "../src/util/secretscan-wasm";
import { redactForStorage } from "../src/util/redact";

const engine = createWasmSecretScan(secretScanWasm());
afterEach(() => setSecretScanEngine(null));
const key = (c: Candidate) => `${c.rule}:${c.start}:${c.end}:${c.sStart}:${c.sEnd}`;
const same = (text: string) => { const a = jsCandidates(text).map(key).sort(); const b = engine.candidates(text)!.map(key).sort(); return { a, b }; };

let seed = 0x2545f491;
const rnd = (n: number, abc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") => { let s = ""; for (let i = 0; i < n; i++) { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); s += abc[((t ^ (t >>> 14)) >>> 0) % abc.length]; } return s; };
const j = (...p: string[]) => p.join(""); // fake keys assembled at run time: the repository holds no secret-shaped literal
const planted = [
  `HF=${j("hf", "_")}${rnd(34, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")} `, `token: ${j("glp", "at-")}${rnd(20)}\n`, `key = "${j("SG", ".")}${rnd(22)}.${rnd(43)}"`,
  `//registry.npmjs.org/:_authToken=${j("np", "m_")}${rnd(36, "abcdefghijklmnopqrstuvwxyz0123456789")}\n`, `DO=${j("dop", "_v1_")}${rnd(64, "0123456789abcdef")}`, `shop = "${j("shp", "at_")}${rnd(32, "0123456789abcdef")}"`,
  `const api_key = "${rnd(32)}";`, `aws = "${j("AK", "IA")}${rnd(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}"`,
];

function corpus(maxBytes: number): string[] {
  const texts: string[] = []; let bytes = 0;
  const walk = (d: string) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (bytes > maxBytes) return; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js|ts|tsx|json)$/.test(e.name) && fs.statSync(p).size < 2e6) { const t = fs.readFileSync(p, "utf8"); texts.push(t); bytes += t.length; } } };
  for (const r of ["../src", "../../server/src", "../../../apps/web/src"]) walk(path.join(__dirname, r));
  for (const r of ["react-dom", "zod", "lucide-react", "cheerio", "monaco-editor/esm/vs/base"]) { const p = path.join(__dirname, "../../../node_modules/.pnpm/node_modules", r); if (fs.existsSync(p)) walk(fs.realpathSync(p)); }
  return texts;
}

describe("Rust/WebAssembly secret-scan engine", () => {
  it("compiles every gitleaks rule (nothing falls back to JS)", () => { expect([...engine.failed]).toEqual([]); });

  it("embedded build is current: it was built from exactly the crate sources in native/secretscan", () => {
    const dir = path.join(__dirname, "../../../native/secretscan"); const h = createHash("sha256");
    for (const f of ["Cargo.toml", "Cargo.lock", ...fs.readdirSync(path.join(dir, "src")).sort().map((x) => `src/${x}`)]) { h.update(f + "\0"); h.update(fs.readFileSync(path.join(dir, f))); h.update("\0"); }
    expect(SECRETSCAN_SOURCE_SHA256, "native/secretscan changed: run node native/secretscan/build.mjs").toBe(h.digest("hex"));
  });

  it("finds exactly the JS reference's candidates on planted secrets, incl. after multi-byte characters", () => {
    for (const p of planted) for (const pre of ["", "émoji 🚀 ünïcödé — ", "日本語のテキスト\n"]) {
      const { a, b } = same(pre + p + " trailing ✓"); expect(b, pre + p).toEqual(a); expect(a.length, pre + p).toBeGreaterThan(0);
    }
  });

  it("identical candidates on ~19 MB of real code (this repo + real packages)", () => {
    const texts = corpus(19_000_000); let n = 0, differ = 0;
    for (const t of texts) { const { a, b } = same(t); n += a.length; if (a.join() !== b.join()) differ++; }
    expect(texts.length).toBeGreaterThan(500);
    expect(differ).toBe(0);
    expect(n).toBeGreaterThan(50); // the corpus exercises many rules (generic keys, tokens in test fixtures)
  }, 300_000);

  it("identical candidates on fuzz (random mixes of keywords, key-shaped strings, separators and unicode)", () => {
    const bits = ["key", "token", "secret", "api", "=", ":", "\"", "'", " ", "\n", "_", "-", ".", "/", "é", "🚀", "hf_", "ghp_", "sk_live_", "AKIA", "xox", "glpat-", "Bearer "];
    for (let i = 0; i < 400; i++) {
      let t = ""; const len = 5 + (i % 60);
      for (let k = 0; k < len; k++) t += Number(rnd(1, "0123")) === 0 ? rnd(8 + (k % 40)) : bits[Number.parseInt(rnd(2, "0123456789"), 10) % bits.length];
      const { a, b } = same(t); expect(b, JSON.stringify(t)).toEqual(a);
    }
  });

  it("redaction output is byte-for-byte the same with the engine installed", () => {
    const text = planted.join("\n") + "\nconst API_KEY = process.env.API_KEY;\nnaïve café ☕ " + planted[0];
    const jsOut = redactForStorage("src/config.ts", text);
    expect(installNativeSecretScan()).toBe(true);
    expect(redactForStorage("src/config.ts", text)).toEqual(jsOut);
    expect(findLeaks(text).length).toBeGreaterThan(5);
  });

  it("maps UTF-8 byte offsets to UTF-16 indices (surrogate pairs included)", () => {
    const t = "a€🚀b"; // bytes: a=0, €=1..4, 🚀=4..8, b=8
    expect(Object.fromEntries(utf8ToUtf16(t, [0, 1, 4, 8, 9]))).toEqual({ 0: 0, 1: 1, 4: 2, 8: 4, 9: 5 });
  });

  it("is several times faster than the JS path on real code", () => {
    const texts = corpus(6_000_000);
    let t = performance.now(); for (const x of texts) jsCandidates(x); const js = performance.now() - t;
    t = performance.now(); for (const x of texts) engine.candidates(x); const rust = performance.now() - t;
    console.log(`secret scan, ${texts.length} files: JS ${js.toFixed(0)} ms · Rust/WASM ${rust.toFixed(0)} ms · ${(js / rust).toFixed(1)}×`);
    expect(js / rust).toBeGreaterThan(3);
  }, 300_000);
});
