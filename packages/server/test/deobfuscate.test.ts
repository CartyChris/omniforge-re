import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDeobfuscator, quickJsSandbox } from "../src/deobfuscate";

const fx = (f: string) => fs.readFileSync(path.join(__dirname, "fixtures/js", f), "utf8");
const d = createDeobfuscator();

describe("webcrack + QuickJS sandbox (real tools, real obfuscated fixtures)", () => {
  it("decodes obfuscator.io output (string array + control-flow flattening) into readable code", async () => {
    const src = fx("obfuscatorio.js");
    expect(src).not.toContain("/api/v2/users"); expect(src).not.toContain("/api/checkout"); // proof the fixture hides its string literals (identifiers like fetchUsers survive; renameGlobals was off)
    const r = await d.deobfuscate(src);
    expect(r.ok, r.error).toBe(true);
    expect(r.code).toContain("fetchUsers"); expect(r.code).toContain("/api/v2/users?limit=50"); expect(r.code).toContain("/api/checkout");
    expect(r.changed).toBe(true); expect(r.tool).toBe("webcrack");
  }, 60_000);
  it("splits a webpack 5.97 bundle into its modules", async () => {
    const r = await d.deobfuscate(fx("webpack-5.97.1.js"));
    expect(r.ok, r.error).toBe(true);
    expect(r.unpacked).toBe(true);
    expect(r.modules!.length).toBeGreaterThanOrEqual(2); // the two imported modules (the entry statements stay in r.code)
    expect(r.modules!.some((m) => m.code.includes("/api/v2/users?limit=50"))).toBe(true);
    expect(r.modules!.some((m) => /Hello, /.test(m.code))).toBe(true);
  }, 60_000);
  it("unminifies terser output", async () => {
    const r = await d.deobfuscate(fx("terser-min.js"));
    expect(r.ok, r.error).toBe(true);
    expect(r.code!.split("\n").length).toBeGreaterThan(fx("terser-min.js").split("\n").length);
    expect(r.code).toContain("/api/checkout");
  }, 60_000);
  it("reports a script it cannot parse as a failure with a reason, never a fake success", async () => {
    const r = await d.deobfuscate("function (((( {{");
    expect(r.ok).toBe(false); expect(r.error).toBeTruthy(); expect(r.code).toBeUndefined();
  }, 60_000);
  it("refuses scripts over the size limit without running anything", async () => {
    const r = await createDeobfuscator({ maxBytes: 100 }).deobfuscate("x".repeat(101));
    expect(r).toMatchObject({ ok: false }); expect(r.error).toMatch(/limit/);
  });
  it("a cancelled run does no work", async () => {
    const ctl = new AbortController(); ctl.abort();
    expect((await d.deobfuscate("var a=1;".repeat(400), { signal: ctl.signal })).error).toBe("cancelled");
  });
});

describe("the sandbox contains hostile decoder code", () => {
  const sb = quickJsSandbox({ timeoutMs: 1500, memoryMB: 16 });
  it("has no host access: process, require, fetch, globalThis.constructor tricks all absent", async () => {
    expect(await sb("[typeof process, typeof require, typeof fetch, typeof module, typeof Buffer, typeof XMLHttpRequest]")).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]);
    await expect(sb("process.exit(1)")).rejects.toThrow(/sandbox/);
    await expect(sb("require('fs').readFileSync('/etc/passwd')")).rejects.toThrow(/sandbox/);
  });
  it("an infinite loop is interrupted at the deadline instead of hanging the engine", async () => {
    const t0 = Date.now();
    await expect(sb("while(true){}")).rejects.toThrow(/sandbox/);
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 15_000);
  it("a memory bomb ends in an error, not an out-of-memory crash of the engine", async () => {
    await expect(sb("const a=[]; while(true){ a.push('x'.repeat(1e6)); }")).rejects.toThrow(/sandbox/);
    expect(await sb("1+1")).toBe(2); // the engine is still usable afterwards
  }, 30_000);
});
