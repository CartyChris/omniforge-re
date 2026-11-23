import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { analyzeJs } from "../src/analyze/js.js";
import { loadOxc, oxcAvailable, parseProgram, setForceAcorn } from "../src/analyze/parse-program.js";

const req = createRequire(import.meta.url);
const fx = (p: string) => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));

const SYNTHETIC = `
import React from "react";
import { useState } from "./state.js";
export const API = "https://api.example.com/v1/users";
export function App() { return React.createElement("div", null, "hi"); }
export class Store {}
const go = async () => {
  await fetch("/api/items", { method: "POST" });
  const ws = new WebSocket("wss://rt.example.com/socket");
  localStorage.setItem("token", "x");
  window.addEventListener("resize", () => {});
  const m = await import("./lazy.js");
  return (\`/api/user/\${1}\`, "/dashboard/settings", m);
};
`;

const BUNDLES: [string, string][] = [
  ["synthetic", SYNTHETIC],
  ["jquery-1.12.4.min.js", readFileSync(fx("retire/jquery-1.12.4.min.js"), "utf8")],
  ["lodash-4.17.4.min.js", readFileSync(fx("retire/lodash-4.17.4.min.js"), "utf8")],
  ["acorn.js", readFileSync(req.resolve("acorn"), "utf8")],
  ["acorn.mjs", readFileSync(req.resolve("acorn").replace(/\.js$/, ".mjs"), "utf8")],
  ["acorn-walk.js", readFileSync(req.resolve("acorn-walk"), "utf8")],
];

describe("parseProgram (oxc primary, acorn fallback)", () => {
  beforeAll(async () => {
    expect(await loadOxc()).toBe(true);
  });
  afterEach(() => setForceAcorn(false));

  it("uses oxc when loaded and acorn when forced", () => {
    expect(oxcAvailable()).toBe(true);
    expect(parseProgram("let a = 1", { sourceType: "module" }).parser).toBe("oxc");
    setForceAcorn(true);
    expect(parseProgram("let a = 1", { sourceType: "module" }).parser).toBe("acorn");
  });

  it("falls back to acorn when oxc rejects the code", () => {
    // `return` at top level: oxc rejects, acorn accepts with allowReturnOutsideFunction
    const r = parseProgram("return 1", { sourceType: "script" });
    expect(r.parser).toBe("acorn");
  });

  for (const [name, code] of BUNDLES) {
    it(`analyzeJs gives identical results via oxc and acorn: ${name}`, () => {
      // the oxc path must really be oxc (not a silent acorn fallback)
      expect(parseProgram(code, { sourceType: "module" }).parser).toBe("oxc");
      const viaOxc = analyzeJs(code);
      setForceAcorn(true);
      const viaAcorn = analyzeJs(code);
      expect(viaOxc.method).toBe("ast");
      expect(viaOxc).toEqual(viaAcorn);
    });
  }

  it("synthetic sample extracts expected items", () => {
    const a = analyzeJs(SYNTHETIC);
    expect(a.imports).toEqual(expect.arrayContaining(["react", "./state.js"]));
    expect(a.dynamicImports).toContain("./lazy.js");
    expect(a.endpoints.map((e) => e.url)).toEqual(expect.arrayContaining(["/api/items", "https://api.example.com/v1/users"]));
  });
});
