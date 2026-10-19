import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { investigateSource } from "@omniforge/core";
import { mergeNoir, parseNoirJson, runNoir } from "../src/bridge/noir";

const FX = path.join(__dirname, "fixtures/noir");
const real = fs.readFileSync(path.join(FX, "noir-1.4.0-scan.json"), "utf8");
const fake = (body: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "fake-noir-")); const p = path.join(d, "noir"); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return p; };

describe("OWASP Noir output (recorded from 1.4.0)", () => {
  it("parses methods, paths, framework, file:line and parameters", () => {
    const r = parseNoirJson(real);
    expect(r.endpoints.map((e) => `${e.method} ${e.url}`).sort()).toEqual(["DELETE /orders/{id}", "GET /api/items", "GET /health", "GET /orders/{id}", "GET /users/{user_id}", "POST /api/items/:id/comments", "POST /users"]);
    expect(r.endpoints.find((e) => e.url === "/users/{user_id}")).toMatchObject({ technology: "python_fastapi", file: "project/py/main.py", line: 4, params: expect.arrayContaining([{ name: "verbose", type: "query" }, { name: "user_id", type: "path" }]) });
    expect(r.errors).toEqual([]);
  });
  it("drops malformed entries and rejects non-JSON", () => {
    expect(parseNoirJson('{"endpoints":[{"url":"/a","method":"get"},{"method":"GET"},null,{"url":""}]}').endpoints).toEqual([{ method: "GET", url: "/a", technology: undefined, file: undefined, line: undefined, params: [] }]);
    expect(() => parseNoirJson("ERROR: boom")).toThrow(/no JSON/);
  });
});

describe("merging into a source analysis", () => {
  it("adds only endpoints OmniForge did not find (placeholder syntax normalised), as recovered evidence with a coverage check", async () => {
    const inv = await investigateSource("p", [{ path: "py/main.py", data: new TextEncoder().encode('@app.get("/users/{user_id}")\ndef f(user_id): pass\n'), origin: "t", provenance: "recovered" }], { kind: "folder", origin: "t" });
    inv.endpoints = [{ url: "/users/:id", method: "GET", kind: "rest", foundIn: "py/main.py", evidence: "x" }];
    mergeNoir(inv, { ok: true, ...parseNoirJson(real), ms: 1200 }, "1.4.0");
    const keys = inv.endpoints.map((e) => `${e.method} ${e.url}`);
    expect(keys.filter((k) => /^GET \/users/.test(k))).toEqual(["GET /users/:id"]); // /users/{user_id} is the same route
    expect(keys).toContain("POST /api/items/:id/comments"); expect(keys).toContain("DELETE /orders/{id}");
    const added = inv.endpoints.find((e) => e.url === "/orders/{id}" && e.method === "DELETE")!;
    expect(added.foundIn).toBe("project/java/src/main/java/app/OrderController.java:7");
    expect(inv.evidence.find((e) => e.id === added.evidence)).toMatchObject({ kind: "recovered", method: "owasp-noir", summary: expect.stringMatching(/java_spring.*id:path/) });
    expect(inv.coverage.checks.find((c) => c.id === "noir")).toMatchObject({ status: "done", detail: expect.stringMatching(/Noir 1\.4\.0 found 7 endpoint\(s\).*6 were new/) });
  });
  it("never claims Noir ran when it did not", async () => {
    const mk = async () => investigateSource("p", [], { kind: "folder", origin: "t" });
    expect((mergeNoir(await mk(), { ok: false, endpoints: [], errors: [], ms: 0, error: "not installed" })).coverage.checks.find((c) => c.id === "noir")).toMatchObject({ status: "skipped", detail: expect.stringMatching(/not installed/) });
    expect((mergeNoir(await mk(), { ok: false, endpoints: [], errors: [], ms: 0, error: "timed out after 1 s" })).coverage.checks.find((c) => c.id === "noir")).toMatchObject({ status: "unavailable", detail: "Noir failed: timed out after 1 s" });
  });
});

describe("running the binary", () => {
  it("uses only the static scan (never AI, probe, export or webhook flags) and reads its JSON", async () => {
    const log = path.join(os.tmpdir(), `noir-args-${Date.now()}`);
    const bin = fake(`echo "$@" > ${log}; cat ${JSON.stringify(path.join(FX, "noir-1.4.0-scan.json"))}`);
    const r = await runNoir(FX, { bin });
    expect(r.ok).toBe(true); expect(r.endpoints).toHaveLength(7);
    const args = fs.readFileSync(log, "utf8");
    expect(args.trim()).toBe("scan . -f json --no-log --no-color --no-spinner --passive-scan-no-update-check");
    expect(args).not.toMatch(/--ai|--probe|--export|-u /);
  });
  it("reports a crash, unreadable output and a hang (killed at the timeout)", async () => {
    expect(await runNoir(FX, { bin: fake('echo "ERROR: Base path does not exist" >&2; exit 1') })).toMatchObject({ ok: false, error: "exited with code 1: ERROR: Base path does not exist" });
    expect((await runNoir(FX, { bin: fake("echo garbage") })).error).toMatch(/unreadable output/);
    const t = Date.now(); const r = await runNoir(FX, { bin: fake("sleep 30"), timeoutMs: 500 });
    expect(r).toMatchObject({ ok: false, error: "timed out after 1 s" }); expect(Date.now() - t).toBeLessThan(5000);
  });
});

// Opt-in: the real binary on the fixture project (NOIR_BIN=/path/to/noir)
describe.skipIf(!process.env.NOIR_BIN)("LIVE OWASP Noir", () => {
  it("finds the fixture project's endpoints", async () => {
    const r = await runNoir(path.join(FX, "project"), { bin: process.env.NOIR_BIN });
    expect(r.ok, r.error).toBe(true);
    expect(r.endpoints.map((e) => `${e.method} ${e.url}`)).toEqual(expect.arrayContaining(["GET /orders/{id}", "POST /users", "GET /api/items", "GET /health"]));
    expect(r.endpoints.find((e) => e.url === "/orders/{id}")!.file).toBe("java/src/main/java/app/OrderController.java");
  }, 120_000);
});
