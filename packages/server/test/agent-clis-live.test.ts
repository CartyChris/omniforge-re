/**
 * The REAL Codex CLI, Gemini CLI, OpenCode and Aider binaries driven through OmniForge's agent harness against a scripted local model
 * (no vendor account needed). Opt-in per CLI: set OMNIFORGE_CODEX_BIN / OMNIFORGE_GEMINI_BIN / OMNIFORGE_OPENCODE_BIN / OMNIFORGE_AIDER_BIN.
 * CI installs pinned versions and runs this, so a CLI release that changes its flags or events fails the build instead of the user's run.
 * Checks: the file reaches the copy (never the project), events normalise, the tool surface is what we asked for, and planted project
 * config (OpenCode plugin, Aider conf, GEMINI.md) does not run or reach the model.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@omniforge/core";
import { createShadow, discardShadow, listChanges, readSides, runAgentCli, type AgentCliRunOptions, type Shadow } from "../src/bridge/agentrun";

const MOCKS = path.join(__dirname, "fixtures/mock-models");
const bins = { codex: process.env.OMNIFORGE_CODEX_BIN, gemini: process.env.OMNIFORGE_GEMINI_BIN, opencode: process.env.OMNIFORGE_OPENCODE_BIN, aider: process.env.OMNIFORGE_AIDER_BIN };
let mock: ChildProcess | undefined; let shadow: Shadow | undefined; let proj = ""; let canaries = "";
afterEach(async () => { mock?.kill(); mock = undefined; if (shadow) await discardShadow(shadow); shadow = undefined; if (proj) fs.rmSync(proj, { recursive: true, force: true }); });

async function setup() {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), "omni-live-proj-")); canaries = fs.mkdtempSync(path.join(os.tmpdir(), "omni-canary-"));
  fs.writeFileSync(path.join(proj, "README.md"), "# demo\n");
  fs.mkdirSync(path.join(proj, ".opencode/plugin"), { recursive: true }); fs.writeFileSync(path.join(proj, ".opencode/plugin/canary.js"), `require("fs").writeFileSync(${JSON.stringify(path.join(canaries, "opencode-plugin"))}, "ran")`);
  fs.writeFileSync(path.join(proj, ".aider.conf.yml"), `auto-test: true\ntest-cmd: touch ${path.join(canaries, "aider-conf")}\n`);
  fs.writeFileSync(path.join(proj, "GEMINI.md"), "CANARY_GEMINI_MD"); fs.writeFileSync(path.join(proj, "AGENTS.md"), "CANARY_AGENTS_MD");
  shadow = await createShadow(proj);
  return { logdir: fs.mkdtempSync(path.join(os.tmpdir(), "omni-mocklog-")), port: 18100 + Math.floor(Math.random() * 800) };
}
const start = (args: string[], env: Record<string, string>) => { mock = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: "ignore" }); return new Promise((r) => setTimeout(r, 1000)); };
async function go(o: Omit<AgentCliRunOptions, "prompt">) { const ev: AgentEvent[] = []; for await (const e of runAgentCli(shadow!, { ...o, prompt: "Create a file hello.txt containing exactly: hi there", timeoutMs: 180_000 })) ev.push(e); return ev; }
async function expectWrote(ev: AgentEvent[]) {
  expect(ev.at(-1), JSON.stringify(ev.slice(-3))).toMatchObject({ type: "result", ok: true });
  expect(ev.some((e) => e.type === "tool" && /hello\.txt/.test(e.summary))).toBe(true);
  const tools = JSON.stringify(ev.filter((e) => e.type === "tool" || e.type === "tool_result"));
  expect((await listChanges(shadow!)).map((c) => `${c.status}:${c.path}`), tools).toEqual(["added:hello.txt"]);
  expect((await readSides(shadow!, "hello.txt")).next?.trim()).toBe("hi there");
  expect(fs.existsSync(path.join(proj, "hello.txt"))).toBe(false);
  expect(fs.readdirSync(canaries)).toEqual([]); // nothing planted in the project ran
}
const requests = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
const body = (r: any) => r.body ?? r;

describe.skipIf(!bins.codex)("LIVE Codex CLI", () => {
  it("writes through apply_patch only (no shell, no web), in a private CODEX_HOME", async () => {
    const { logdir, port } = await setup(); await start([path.join(MOCKS, "responses-and-chat.mjs")], { MOCK_PORT: String(port), MOCK_LOG: logdir });
    await expectWrote(await go({ cli: "codex", cliPath: bins.codex!, model: "gpt-5.5", env: { MOCK_API_KEY: "dummy" }, codexAuthDir: canaries,
      extraArgs: ["-c", "model_provider=mock", "-c", `model_providers.mock={name="Mock",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",env_key="MOCK_API_KEY",request_max_retries=0,stream_max_retries=0}`] }));
    const tools = (body(requests(logdir)[0]).tools ?? []).map((t: any) => t.name ?? t.type);
    expect(tools).toContain("apply_patch"); for (const t of ["exec_command", "web_search", "create_goal"]) expect(tools).not.toContain(t);
    expect(JSON.stringify(requests(logdir))).not.toContain("CANARY_AGENTS_MD");
  }, 240_000);
});

describe.skipIf(!bins.gemini)("LIVE Gemini CLI", () => {
  it("writes with write_file; shell and web tools are off; project GEMINI.md never reaches the model", async () => {
    const { logdir, port } = await setup(); await start([path.join(MOCKS, "gemini-and-chat.mjs"), String(port), "gemini", logdir], { MOCK_PROJECT_DIR: shadow!.work });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-gemhome-")); fs.mkdirSync(path.join(home, ".gemini")); fs.writeFileSync(path.join(home, ".gemini/settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }));
    await expectWrote(await go({ cli: "gemini", cliPath: bins.gemini!, model: "gemini-2.5-pro", geminiAuthDir: home, env: { GEMINI_API_KEY: "dummy", GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}` } }));
    const names = (body(requests(logdir)[0]).tools ?? []).flatMap((t: any) => t.functionDeclarations ?? []).map((d: any) => d.name);
    expect(names).toContain("write_file"); for (const t of ["run_shell_command", "web_fetch", "google_web_search"]) expect(names).not.toContain(t);
    expect(JSON.stringify(requests(logdir))).not.toContain("CANARY_GEMINI_MD");
  }, 240_000);
});

describe.skipIf(!bins.opencode)("LIVE OpenCode", () => {
  it("writes with write; bash and webfetch removed; the project's .opencode plugin never runs", async () => {
    const { logdir, port } = await setup(); await start([path.join(MOCKS, "responses-and-chat.mjs")], { MOCK_PORT: String(port), MOCK_LOG: logdir });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ochome-"));
    await expectWrote(await go({ cli: "opencode", cliPath: bins.opencode!, model: "mock/mock-model", env: { HOME: home, OPENCODE_DISABLE_MODELS_FETCH: "1" },
      overlay: { opencodeConfig: { provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "dummy" }, models: { "mock-model": { name: "Mock", tool_call: true } } } } } } }));
    const names = (body(requests(logdir)[0]).tools ?? []).map((t: any) => t.function?.name);
    expect(names).toContain("write"); for (const t of ["bash", "webfetch"]) expect(names).not.toContain(t);
    expect(JSON.stringify(requests(logdir))).not.toContain("CANARY_AGENTS_MD");
  }, 240_000);
});

describe.skipIf(!bins.aider)("LIVE Aider", () => {
  it("edits through the copy's git repo with an isolated HOME; the project's .aider.conf.yml (auto-test command) is stripped and never runs", async () => {
    const { logdir, port } = await setup(); await start([path.join(MOCKS, "gemini-and-chat.mjs"), String(port), "openai-whole", logdir], {});
    await expectWrote(await go({ cli: "aider", cliPath: bins.aider!, aider: { model: "openai/mock", keyEnv: "OPENAI_API_KEY", key: "dummy", apiBase: `http://127.0.0.1:${port}/v1` }, extraArgs: ["--map-tokens", "0", "hello.txt"] }));
  }, 240_000);
});

/* ---- the same CLIs as plain chat providers (read-only invocations) ---- */
import { collect } from "@omniforge/core";
import { ADAPTERS, runCli, type CliInfo } from "../src/bridge/clis";
const infoFor = (id: string, p: string, method: string): CliInfo => ({ id, name: id, vendor: "", status: "ready", path: p, method, methods: [], install: "", agentic: true });

describe.skipIf(!bins.gemini)("LIVE Gemini CLI as a chat provider", () => {
  it("answers through the recorded normaliser in read-only (plan) mode", async () => {
    const { logdir, port } = await setup(); await start([path.join(MOCKS, "gemini-and-chat.mjs"), String(port), "gemini-text", logdir], {});
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-gemhome-")); fs.mkdirSync(path.join(home, ".gemini")); fs.writeFileSync(path.join(home, ".gemini/settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }));
    const r = await collect(runCli(ADAPTERS.find((a) => a.id === "gemini")!, infoFor("gemini", bins.gemini!, "prompt-stream-json"), { prompt: "Say hi", model: "gemini-2.5-pro", cwd: shadow!.work, env: { HOME: home, GEMINI_CLI_HOME: home, GEMINI_API_KEY: "dummy", GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}` }, timeoutMs: 120_000 }));
    expect(r.text.trim().length).toBeGreaterThan(0); expect(r.finish).toBe("stop");
    expect((await listChanges(shadow!))).toEqual([]); // read-only: nothing written
  }, 180_000);
});

describe.skipIf(!bins.opencode)("LIVE OpenCode as a chat provider", () => {
  it("answers with edits and shell denied (prompt on stdin)", async () => {
    const { logdir, port } = await setup(); await start([path.join(MOCKS, "responses-and-chat.mjs")], { MOCK_PORT: String(port), MOCK_LOG: logdir, MOCK_PREFER: "text" });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ochome-"));
    const cfg = { provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "dummy" }, models: { "mock-model": { name: "Mock", tool_call: true } } } } };
    const r = await collect(runCli(ADAPTERS.find((a) => a.id === "opencode")!, infoFor("opencode", bins.opencode!, "run-json"), { prompt: "Say hi", model: "mock/mock-model", cwd: shadow!.work, env: { HOME: home, OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg), OPENCODE_DISABLE_MODELS_FETCH: "1" }, timeoutMs: 120_000 }));
    expect(r.text.trim().length).toBeGreaterThan(0);
    const names = (body(requests(logdir)[0]).tools ?? []).map((t: any) => t.function?.name);
    for (const t of ["bash", "write", "edit", "webfetch"]) expect(names).not.toContain(t);
    expect((await listChanges(shadow!))).toEqual([]);
  }, 180_000);
});
