import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobManager } from "../src/bridge/jobs";
import { REA_OPS, ReaJobs, applyReaInstall, discoverReaMcp, planReaInstall, progressParser, reaBinary, reaStatus, reaSummary, reaToInvestigation } from "../src/bridge/rea";
import { backupFiles, listBackups, readChanges, restoreBackup } from "../src/bridge/changelog";
import { renderMarkdown } from "@omniforge/core";

const SAMPLE = path.resolve(__dirname, "../../../fixtures/electron-sample");
const REA = path.resolve(__dirname, "../node_modules/.bin/rea");
let tmp: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 90_000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await sleep(100); } }

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-rea-"));
  process.env.REA_BIN = REA;
  process.env.OMNIFORGE_HOME = path.join(tmp, "home");
});
afterAll(() => { delete process.env.REA_BIN; delete process.env.OMNIFORGE_HOME; fs.rmSync(tmp, { recursive: true, force: true }); });

describe("REA status (real binary)", () => {
  it("finds the installed REA, reads its version and per-provider availability from REA itself", async () => {
    expect(reaBinary()).toBe(REA);
    const s = await reaStatus();
    expect(s).toMatchObject({ status: "available", version: "6.5.0", via: "binary" });
    const by = Object.fromEntries(s.providers.map((p) => [p.id, p]));
    expect(by["rea-artifact-graph"]!.status).toBe("available");
    expect(by["rea-dotnet-static"]!.status).toBe("available");
    if (process.platform !== "darwin") expect(by["native-macos"]!.status).toBe("unsupported-platform");
    expect(by["native-macos"]!.reasons.join()).toMatch(/macOS/);
    // doctor classifications surface as actionable "requires configuration" items
    const ghidra = s.doctor!.find((d) => d.name === "ghidra")!;
    expect(ghidra).toMatchObject({ ok: false, classification: "missing_analysis_engine" });
    expect(ghidra.remediation).toMatch(/GHIDRA_INSTALL_DIR/);
  }, 120_000);
  it("reports not-installed when REA is absent", async () => {
    const keep = process.env.REA_BIN; const keepPath = process.env.PATH;
    process.env.REA_BIN = "/nonexistent/rea"; process.env.PATH = "/nonexistent";
    try { expect(await reaStatus()).toMatchObject({ status: "not-installed", via: "none" }); } finally { process.env.REA_BIN = keep; process.env.PATH = keepPath; }
  });
});

describe("REA job on a real Electron-style app", () => {
  let jobs: JobManager; let rj: ReaJobs; let id: string; let progressSeen: string[] = [];
  beforeAll(async () => {
    jobs = new JobManager({ dir: path.join(tmp, "jobs") });
    rj = new ReaJobs(jobs, path.join(tmp, "rea"));
    const meta = rj.start("analyze-javascript-application", SAMPLE);
    id = meta.id;
    const t = Date.now();
    while (jobs.get(id)!.meta.state === "running" && Date.now() - t < 90_000) { const p = jobs.get(id)!.meta.progress; if (p && !progressSeen.includes(p.message)) progressSeen.push(p.message); await sleep(40); }
    await until(() => fs.existsSync(rj.resultPath(id)), 20_000);
  }, 120_000);

  it("completes with live progress parsed from REA's own rea_progress stream", () => {
    expect(jobs.get(id)!.meta.state).toBe("done");
    expect(progressSeen.length).toBeGreaterThan(0);
    expect(jobs.get(id)!.meta.progress!.phase).toBeTruthy();
    expect(progressParser('{"rea_progress":{"phase":"p","completed":1,"total":4,"message":"m"}}')).toEqual({ phase: "p", completed: 1, total: 4, message: "m" });
    expect(progressParser("plain log line")).toBeUndefined();
  });
  it("retrieves REAL evidence: subject hash, provider, authority and its stated limitations", () => {
    const env = rj.result(id)!;
    const sum = reaSummary(env);
    expect(sum).toMatchObject({ operation: "analyze_javascript_application", provider: { id: expect.any(String) }, authority: "shipped-artifact", confidence: "derived" });
    expect(sum.summary.ipc.main_handlers).toBe(2);
    expect(sum.summary.context_bridge_apis).toBe(1);
    expect(sum.limitations.join()).toMatch(/inert syntax|runtime/i);
    expect(env.subject.digest!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("maps REA's graph into an Investigation without inventing anything", () => {
    const env = rj.result(id)!;
    const inv = reaToInvestigation(env, { name: "sample-electron", targetPath: SAMPLE });
    const f = Object.fromEntries(inv.features.map((x) => [x.name, x]));
    expect(f["Electron IPC bridge"]!.spec.inputs.join("\n")).toMatch(/clipboard:read/);
    expect(f["Electron IPC bridge"]!.spec.inputs.join("\n")).toMatch(/app:quit/);
    expect(f["Renderer-exposed API (contextBridge)"]!.spec.outputs).toEqual(expect.arrayContaining(["window.api.readClipboard()", "window.api.quit()"]));
    expect(f["Application windows"]!.description).toBe("1 BrowserWindow(s)");
    expect(inv.endpoints.map((e) => e.url)).toContain("/api/ping");
    expect(inv.technologies.map((t) => t.name)).toEqual(expect.arrayContaining(["REA", "Electron"]));
    // every claim resolves to stored evidence, and the root evidence carries REA's own hash
    const root = inv.evidence.find((e) => e.method === "rea:analyze_javascript_application" && e.hash)!;
    expect(root.hash).toBe(env.subject.digest!.sha256);
    expect(root.summary).toMatch(/authority “shipped-artifact”/);
    for (const ft of inv.features) for (const e of ft.evidence) expect(inv.evidence.some((x) => x.id === e)).toBe(true);
    expect(inv.graph.nodes.some((n) => n.type === "endpoint" && n.label === "clipboard:read")).toBe(true);
    const ids = new Set(inv.graph.nodes.map((n) => n.id));
    expect(inv.graph.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(inv.coverage.checks.find((c) => c.id === "runtime")!.status).toBe("skipped");
    expect(inv.limitations.length).toBeGreaterThan(0);
    // this sample is configured securely: no high-severity findings may be fabricated
    expect(inv.findings.filter((x) => x.severity === "high")).toEqual([]);
    expect(renderMarkdown(inv)).toMatch(/Electron IPC bridge/);
  });
  it("flags insecure Electron configuration it actually observes (nodeIntegration / contextIsolation)", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "insecure-"));
    for (const f of fs.readdirSync(SAMPLE)) fs.copyFileSync(path.join(SAMPLE, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, "main.js"), fs.readFileSync(path.join(dir, "main.js"), "utf8").replace("contextIsolation: true, nodeIntegration: false", "contextIsolation: false, nodeIntegration: true"));
    const meta = rj.start("analyze-javascript-application", dir);
    await until(() => jobs.get(meta.id)!.meta.state !== "running");
    await until(() => fs.existsSync(rj.resultPath(meta.id)), 20_000);
    const inv = reaToInvestigation(rj.result(meta.id)!, { targetPath: dir });
    const titles = inv.findings.map((x) => x.title);
    expect(titles).toContain("nodeIntegration is enabled for a renderer");
    expect(titles).toContain("contextIsolation is disabled");
    expect(inv.findings.find((x) => /nodeIntegration/.test(x.title))!.severity).toBe("high");
  }, 120_000);
});

describe("REA guardrails", () => {
  const mk = () => new ReaJobs(new JobManager({ dir: fs.mkdtempSync(path.join(tmp, "j-")) }), path.join(tmp, "rea2"));
  it("only runs allow-listed static operations on absolute, existing paths", () => {
    const rj = mk();
    expect(() => rj.start("setup", SAMPLE)).toThrow(/not an allowed REA operation/);
    expect(() => rj.start("instrument-with-frida", SAMPLE)).toThrow(/not an allowed/);
    expect(() => rj.start("capture-process", SAMPLE)).toThrow(/not an allowed/);
    expect(() => rj.start("analyze-javascript-application", "relative/path")).toThrow(/absolute/);
    expect(() => rj.start("analyze-javascript-application", "/definitely/not/here")).toThrow(/Not found/);
    expect(REA_OPS.every((o) => !/^(capture|observe|instrument|debug|install|push|pull|uninstall)/.test(o.id))).toBe(true);
  });
  it("native analysis launches Hopper/Ghidra/IDA and needs explicit approval", () => {
    expect(() => mk().start("analyze", SAMPLE)).toThrow(/needs explicit approval/);
  });
  it("macOS-only operations are refused elsewhere", () => {
    if (process.platform !== "darwin") expect(() => mk().start("inspect-macho", SAMPLE)).toThrow(/not supported on/);
  });
});

describe("REA install: plan → approval → backup → recoverable record", () => {
  it("shows exactly what would change and changes nothing until approved", () => {
    const home = path.join(tmp, "fakehome"); fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const plan = planReaInstall(home);
    expect(plan.backups).toContain(path.join(home, ".claude.json"));
    expect(plan.steps.find((s) => s.id === "register")).toMatchObject({ command: "rea setup", interactive: true });
    expect(plan.note).toMatch(/Nothing is changed until you approve/);
    expect(() => applyReaInstall(new JobManager({ dir: path.join(tmp, "j3") }), { approved: false })).toThrow(/not approved/);
    expect(readChanges()).toEqual([]);
  });
  it("backs up existing agent configs, records the change, and can restore them byte-for-byte", () => {
    const home = path.join(tmp, "fakehome2"); fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const cfg = path.join(home, ".codex", "config.toml");
    fs.writeFileSync(cfg, '[mcp_servers.other]\ncommand = "x"\n');
    const b = backupFiles([cfg, path.join(home, "missing.json")]);
    expect(b.saved).toEqual([cfg]);
    fs.writeFileSync(cfg, "CLOBBERED");
    expect(restoreBackup(b.dir)).toEqual([cfg]);
    expect(fs.readFileSync(cfg, "utf8")).toBe('[mcp_servers.other]\ncommand = "x"\n');
    expect(listBackups()[0]!.files).toBe(1);
    expect(readChanges()[0]).toMatchObject({ action: "restore" });
  });
  it("discovers existing REA MCP registrations without modifying anything", () => {
    const home = path.join(tmp, "fakehome3"); fs.mkdirSync(path.join(home, ".cursor"), { recursive: true }); fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { rea: { command: "npx", args: ["-y", "rea-agents", "mcp"] } } }));
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), '[mcp_servers.other]\ncommand="y"');
    const by = Object.fromEntries(discoverReaMcp(home).map((x) => [x.agent, x.registered]));
    expect(by["Cursor"]).toBe(true);
    expect(by["Codex"]).toBe(false);
    expect(by["Claude Code"]).toBe(false);
  });
});
