import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_CLIS, createNormalizer, planAgentRun, type AgentCliId } from "../src/ai/cliagents";
import type { AgentEvent } from "../src/ai/cliagent";

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/transcripts/${f}`, import.meta.url), "utf8");
function run(id: Exclude<AgentCliId, "claude-code">, file: string, code: number | null, ctx: { work?: string; mcpServers?: string[] } = {}, stderr = ""): AgentEvent[] {
  const n = createNormalizer(id, ctx); const out: AgentEvent[] = [];
  for (const l of fx(file).split("\n")) out.push(...n.line(l));
  out.push(...n.end(code, stderr)); return out;
}
const results = (e: AgentEvent[]) => e.filter((x) => x.type === "result" || x.type === "error");

describe("Codex CLI 0.163.0 (recorded)", () => {
  it("file write via apply_patch: tool event with a path relative to the copy, final message, success", () => {
    const e = run("codex", "codex-0.163.0-write-file.jsonl", 0, { work: "/tmp/project" });
    expect(e[0]).toEqual({ type: "init", tools: [] });
    expect(e).toContainEqual({ type: "tool", name: "Write", summary: "Write hello.txt", path: "hello.txt" });
    expect(e.filter((x) => x.type === "tool")).toHaveLength(1); // started+completed → one tool event
    expect(e).toContainEqual({ type: "text", text: 'Created hello.txt containing "hi there".' });
    expect(results(e)).toEqual([expect.objectContaining({ type: "result", ok: true, text: 'Created hello.txt containing "hi there".' })]);
  });
  it("shell writes show the command (without the bash -lc wrapper) and its exit code", () => {
    const e = run("codex", "codex-0.163.0-write-file-exec-command.jsonl", 0);
    expect(e).toContainEqual({ type: "tool", name: "Bash", summary: "Run: printf 'hi there\\\\n' > hello.txt" });
    expect(e).toContainEqual({ type: "tool_result", ok: true, summary: "exit 0" });
  });
  it("MCP calls are named mcp__server__tool", () => {
    const e = run("codex", "codex-0.163.0-mcp-tool-call.jsonl", 0);
    expect(e).toContainEqual({ type: "tool", name: "mcp__omni__ping", summary: "omni (MCP): ping" });
    expect(e).toContainEqual({ type: "tool_result", ok: true, summary: "omni/ping answered" });
  });
  it("failures: turn.failed is the result; retry notices are notices; 401 text is kept", () => {
    expect(results(run("codex", "codex-0.163.0-error.jsonl", 1))).toEqual([expect.objectContaining({ ok: false, text: expect.stringMatching(/high demand/) })]);
    const retry = run("codex", "codex-0.163.0-error-http500-default-retries.jsonl", 1);
    expect(retry.filter((x) => x.type === "notice" && /Reconnecting/.test(x.text)).length).toBeGreaterThanOrEqual(3);
    expect(results(retry)).toHaveLength(1);
    expect(results(run("codex", "codex-0.163.0-error-http401.jsonl", 1))[0]).toMatchObject({ ok: false, text: expect.stringMatching(/401 Unauthorized/) });
  });
  it("no result line at all (config error on stderr) → an error naming the cause", () => {
    const n = createNormalizer("codex"); expect(n.end(1, "WARNING: proceeding, even though…\nError loading config.toml: bad\n")).toEqual([{ type: "error", message: "Codex exited (code 1) without a result: Error loading config.toml: bad" }]);
  });
});

describe("Gemini CLI 0.64.0 (recorded)", () => {
  it("joins assistant deltas, maps write_file, success from result.status", () => {
    const e = run("gemini", "gemini-0.64.0-write-file.jsonl", 0, { work: "/tmp/claude-0/runs/gem1/proj" });
    expect(e[0]).toMatchObject({ type: "init", model: "auto" });
    expect(e).toContainEqual({ type: "tool", name: "Write", summary: "Write hello.txt", path: "hello.txt" });
    expect(results(e)).toEqual([expect.objectContaining({ ok: true })]);
    expect(e.filter((x) => x.type === "text").length).toBeGreaterThan(0);
  });
  it("MCP tools are recognised for the servers we passed", () => {
    const e = run("gemini", "gemini-0.64.0-mcp-tool.jsonl", 0, { mcpServers: ["omni"] });
    expect(e).toContainEqual({ type: "tool", name: "mcp__omni__echo_marker", summary: "omni (MCP): echo_marker" });
    expect(e).toContainEqual({ type: "text", text: "Created `hello.txt` containing `hi there`." }); // deltas joined
  });
  it("errors: API error (exit 244), safety block reported as failure even though exit is 0, turn limit, tool error keeps going", () => {
    expect(results(run("gemini", "gemini-0.64.0-error.jsonl", 244))[0]).toMatchObject({ ok: false, text: expect.stringMatching(/Mock internal error/) });
    const safety = run("gemini", "gemini-0.64.0-safety-blocked.jsonl", 0);
    expect(results(safety)[0]).toMatchObject({ ok: false, text: expect.stringMatching(/safety/) });
    expect(results(run("gemini", "gemini-0.64.0-turn-limit.jsonl", 53))[0]).toMatchObject({ ok: false, text: expect.stringMatching(/max session turns/) });
    const tool = run("gemini", "gemini-0.64.0-tool-error.jsonl", 0);
    expect(tool.some((x) => x.type === "tool_result" && !x.ok)).toBe(true);
  });
  it("not signed in (exit 41, nothing on stdout) explains how to sign in", () => {
    expect(createNormalizer("gemini").end(41, "")).toEqual([{ type: "error", message: expect.stringMatching(/not signed in.*Sign in with Google/) }]);
  });
});

describe("OpenCode 1.19.3 (recorded)", () => {
  it("write tool, final text, success from the last step stop + exit 0", () => {
    const e = run("opencode", "opencode-1.19.3-write-file.jsonl", 0, { work: "/tmp/project" });
    expect(e).toContainEqual({ type: "tool", name: "Write", summary: "Write hello.txt", path: "hello.txt" });
    expect(results(e)).toEqual([expect.objectContaining({ ok: true, text: 'Created hello.txt containing "hi there".' })]);
    expect(run("opencode", "opencode-1.19.3-write-file-bash.jsonl", 0)).toContainEqual(expect.objectContaining({ type: "tool", name: "Bash", summary: expect.stringMatching(/^Run: printf/) }));
  });
  it("MCP tools are named server_tool", () => {
    expect(run("opencode", "opencode-1.19.3-mcp-tool-call.jsonl", 0, { mcpServers: ["omni"] })).toContainEqual({ type: "tool", name: "mcp__omni__ping", summary: "omni (MCP): ping" });
  });
  it("errors: API error is the result; a refused tool is a failure even though exit is 0", () => {
    expect(results(run("opencode", "opencode-1.19.3-error-http401.jsonl", 1))).toEqual([expect.objectContaining({ ok: false, text: expect.stringMatching(/Incorrect API key.*HTTP 401/) })]);
    expect(results(run("opencode", "opencode-1.19.3-error.jsonl", 1))[0]).toMatchObject({ ok: false });
    expect(results(run("opencode", "opencode-1.19.3-permission-ask-autorejected.jsonl", 0))[0]).toMatchObject({ ok: false, text: expect.stringMatching(/refused/) });
  });
});

describe("Aider 0.86.2 (recorded plain text)", () => {
  it("whole and diff formats: 'Applied edit' is the success signal", () => {
    for (const f of ["aider-0.86.2-write-file.txt", "aider-0.86.2-write-file-diff-format.txt", "aider-0.86.2-edit-file-diff-format.txt"]) {
      const e = run("aider", f, 0);
      expect(e.find((x) => x.type === "tool"), f).toMatchObject({ name: "Edit", path: "hello.txt" });
      expect(results(e), f).toEqual([expect.objectContaining({ ok: true })]);
    }
    expect(run("aider", "aider-0.86.2-write-file.txt", 0)).toContainEqual({ type: "init", model: "openai/mock", tools: [] });
  });
  it("exit 0 is not trusted: API errors and edits that never applied are failures", () => {
    const e500 = run("aider", "aider-0.86.2-error.txt", 0);
    expect(results(e500)).toEqual([expect.objectContaining({ ok: false, text: expect.stringMatching(/InternalServerError/) })]);
    expect(e500.filter((x) => x.type === "notice").length).toBeGreaterThan(3);
    expect(results(run("aider", "aider-0.86.2-error-401.txt", 0))[0]).toMatchObject({ ok: false, text: expect.stringMatching(/AuthenticationError/) });
    expect(results(run("aider", "aider-0.86.2-edit-format-mismatch.txt", 0))[0]).toMatchObject({ ok: false, text: expect.stringMatching(/did not apply/) });
  });
});

describe("planAgentRun", () => {
  const base = { prompt: "Add a footer", work: "/tmp/r/work", runDir: "/tmp/r" };
  it("Codex: isolation flags, no shell unless commands are allowed, private CODEX_HOME, MCP as -c overrides", () => {
    const p = planAgentRun("codex", { ...base, mcpServers: [{ name: "docs", command: "npx", args: ["-y", "d@1.0.0"] }] });
    expect(p.args.slice(0, 6)).toEqual(["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--sandbox"]);
    expect(p.args).toEqual(expect.arrayContaining(["project_doc_max_bytes=0", "shell_tool", "unified_exec", 'mcp_servers.docs.command="npx"', 'mcp_servers.docs.args=["-y","d@1.0.0"]', 'mcp_servers.docs.default_tools_approval_mode="approve"']));
    expect(p.args.at(-1)).toBe("Add a footer"); expect(p.args[p.args.indexOf("-C") + 1]).toBe("/tmp/r/work");
    expect(p.env.CODEX_HOME).toBe("/tmp/r/codex-home"); expect(p.args).not.toContain("--dangerously-bypass-hook-trust");
    expect(planAgentRun("codex", { ...base, allowedCommands: ["npm test"] }).args).not.toContain("shell_tool");
  });
  it("Gemini: OmniForge settings in a private GEMINI_CLI_HOME; shell and web off unless allowed; only our MCP servers; user's sign-in method kept", () => {
    const p = planAgentRun("gemini", { ...base, geminiAuthType: "oauth-personal" });
    expect(p.args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--approval-mode", "yolo", "--skip-trust", "--allowed-mcp-server-names", "omniforge-none"]));
    expect(p.env).toMatchObject({ GEMINI_CLI_HOME: "/tmp/r/gemini-home", HOME: "/tmp/r/gemini-home" }); expect(p.files[0]!.path).toBe("/tmp/r/gemini-home/.gemini/settings.json");
    const s = JSON.parse(p.files[0]!.content);
    expect(s).toMatchObject({ advanced: { ignoreLocalEnv: true }, security: { auth: { selectedType: "oauth-personal" } }, tools: { exclude: ["run_shell_command", "web_fetch", "google_web_search"] } });
    const c = JSON.parse(planAgentRun("gemini", { ...base, allowedCommands: ["npm test"], mcpServers: [{ name: "omni", url: "https://x.example/mcp" }] }).files[0]!.content);
    expect(c.tools.core).toContain("run_shell_command(npm test)"); expect(c.mcpServers.omni).toEqual({ httpUrl: "https://x.example/mcp", trust: true });
  });
  it("OpenCode: prompt on stdin (positional prompts get quoted), project config off, bash denied or pattern-limited", () => {
    const p = planAgentRun("opencode", base); expect(p.stdin).toBe("Add a footer"); expect(p.args).not.toContain("Add a footer");
    expect(p.env).toMatchObject({ OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" });
    expect(JSON.parse(p.env.OPENCODE_PERMISSION!).bash).toBe("deny");
    expect(JSON.parse(planAgentRun("opencode", { ...base, allowedCommands: ["npm test"] }).env.OPENCODE_PERMISSION!).bash).toEqual({ "*": "deny", "npm test*": "allow" });
  });
  it("Aider: needs a model, isolated HOME, history outside the copy, every auto-run feature off", () => {
    expect(() => planAgentRun("aider", base)).toThrow(/needs a model/);
    const p = planAgentRun("aider", { ...base, aider: { model: "openrouter/anthropic/claude-sonnet-4.5", keyEnv: "OPENROUTER_API_KEY", key: "sk-or-x" } });
    expect(p.env).toMatchObject({ HOME: "/tmp/r/aider-home", OPENROUTER_API_KEY: "sk-or-x" });
    expect(p.args).toEqual(expect.arrayContaining(["--no-auto-test", "--no-auto-lint", "--no-suggest-shell-commands", "--no-auto-commits", "--no-dirty-commits"]));
    expect(p.args[p.args.indexOf("--chat-history-file") + 1]!.startsWith("/tmp/r/")).toBe(true); expect(p.args[p.args.indexOf("--chat-history-file") + 1]!.startsWith("/tmp/r/work")).toBe(false);
  });
  it("rejects unsafe commands and MCP servers for every CLI", () => {
    for (const id of ["codex", "gemini", "opencode"] as const) {
      expect(() => planAgentRun(id, { ...base, allowedCommands: ["rm -rf /"] }), id).toThrow();
      expect(() => planAgentRun(id, { ...base, mcpServers: [{ name: "x", command: "bash", args: ["-c", "id"] }] }), id).toThrow(/cannot be used/);
    }
    expect(AGENT_CLIS.map((c) => c.id)).toEqual(["claude-code", "codex", "gemini", "opencode", "aider"]);
  });
});
