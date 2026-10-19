/** gitleaks' rules as data: every rule compiles in plain JS, real key formats are caught, ordinary code is left alone. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findLeaks, gitleaksRules, redactLeaks, shannon } from "../src/util/gitleaks";
import { GITLEAKS } from "../src/util/gitleaks-rules";
import { redactForStorage, redactSecrets } from "../src/util/redact";

// Fake keys are assembled at run time so this repository holds no secret-shaped literal (scanners would flag it, rightly).
let seed = 0x9e3779b9;
const rnd = (n: number, abc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") => { let s = ""; for (let i = 0; i < n; i++) { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); s += abc[((t ^ (t >>> 14)) >>> 0) % abc.length]; } return s; }; // mulberry32
const j = (...p: string[]) => p.join("");
const SAMPLES: [string, string][] = [
  ["huggingface-access-token", `HF_TOKEN=${j("hf", "_")}${rnd(34, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")}\n`],
  ["gitlab-pat", `token: ${j("glp", "at-")}${rnd(20)}\n`],
  ["sendgrid-api-token", `key = "${j("SG", ".")}${rnd(22)}.${rnd(43)}"\n`],
  ["npm-access-token", `//registry.npmjs.org/:_authToken=${j("np", "m_")}${rnd(36, "abcdefghijklmnopqrstuvwxyz0123456789")}\n`],
  ["digitalocean-pat", `DO=${j("dop", "_v1_")}${rnd(64, "0123456789abcdef")}\n`],
  ["shopify-access-token", `shop = "${j("shp", "at_")}${rnd(32, "0123456789abcdef")}"\n`],
];

describe("gitleaks rules (data)", () => {
  it("imports every default rule and compiles all of them in JS (inline modifiers expanded)", () => {
    expect(GITLEAKS.version).toBe("8.30.1");
    expect(GITLEAKS.rules.length).toBe(221);
    const c = gitleaksRules();
    expect(c.skipped).toEqual([]);
    expect(c.rules.every((r) => r.re.flags === "g")).toBe(true); // no engine-specific flags or modifiers
  });

  it("finds each provider's key format and redacts only the secret", () => {
    for (const [rule, text] of SAMPLES) {
      const leaks = findLeaks(text);
      expect(leaks.map((l) => l.rule), `${rule}: ${text}`).toContain(rule);
      const r = redactLeaks(text);
      expect(r.text).toContain(`[REDACTED:gitleaks:`);
      expect(r.text.length).toBeLessThan(text.length + 40);
    }
  });

  it("modifier expansion keeps case where gitleaks requires it: `(?-i:atlasv1)` stays lowercase", () => {
    const tok = `${rnd(14, "abcdefghij0123456789")}.atlasv1.${rnd(64, "abcdefghij0123456789")}`;
    expect(findLeaks(`tf = "${tok}"`).map((l) => l.rule)).toContain("hashicorp-tf-api-token");
    expect(findLeaks(`tf = "${tok.replace("atlasv1", "ATLASV1")}"`).map((l) => l.rule)).not.toContain("hashicorp-tf-api-token");
  });

  it("applies the entropy floor and stopwords", () => {
    expect(shannon("aaaaaaaa")).toBe(0);
    expect(shannon("abcd")).toBe(2);
    const low = `${j("hf", "_")}${"ab".repeat(17)}`; // the right shape, but far below the rule's entropy floor
    expect(new RegExp(gitleaksRules().rules.find((r) => r.id === "huggingface-access-token")!.re.source).test(`${low} `)).toBe(true);
    expect(findLeaks(`${low} `).map((l) => l.rule)).not.toContain("huggingface-access-token");
  });

  it("leaves ordinary code alone (env lookups, identifiers, hashes in lockfiles)", () => {
    const benign = [
      "const API_KEY = process.env.API_KEY;",
      "const token = await getAccessToken(session);",
      "password: z.string().min(8),",
      `"integrity": "sha512-${rnd(86, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/")}=="`,
      "export const authHeader = `Bearer ${token}`;",
      "<input type=\"password\" name=\"password\" autocomplete=\"current-password\">",
    ].join("\n");
    expect(findLeaks(benign)).toEqual([]);
  });

  it("no false positives on this repository's own source (≈1.4 MB of real TS/TSX), and fast enough to run on every file", () => {
    const roots = ["../src", "../../server/src", "../../../apps/web/src"].map((r) => path.join(__dirname, r));
    let files = 0, bytes = 0; const hits: string[] = []; const t0 = performance.now();
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx|mjs|json)$/.test(e.name) && !e.name.startsWith("gitleaks-rules")) { const t = fs.readFileSync(p, "utf8"); files++; bytes += t.length; for (const l of findLeaks(t, { path: p })) hits.push(`${l.rule} ${p}`); } } };
    for (const r of roots) walk(r);
    expect(files).toBeGreaterThan(100); expect(bytes).toBeGreaterThan(1_000_000);
    expect(hits).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("is part of redaction for storage and for prompts", () => {
    const text = `fetch(url, { headers: { authorization: "${j("hf", "_")}${rnd(34, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")}" } });\n`;
    const s = redactForStorage("src/config.ts", text);
    expect(s.text).not.toMatch(/hf_[A-Za-z]{34}/); expect(s.kinds).toContain("gitleaks:huggingface-access-token");
    const p = redactSecrets(text);
    expect(p.text).not.toMatch(/hf_[A-Za-z]{34}/); expect(p.found).toContain("gitleaks:huggingface-access-token");
    expect(redactForStorage("src/a.ts", "const API_KEY = process.env.API_KEY;\n").text).toBe("const API_KEY = process.env.API_KEY;\n");
  });
});
