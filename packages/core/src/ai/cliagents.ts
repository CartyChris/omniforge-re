/**
 * Agent mode for the other coding CLIs: OpenAI Codex CLI, Google Gemini CLI, OpenCode and Aider.
 * Like Claude Code (cliagent.ts) each one edits an ISOLATED COPY of a folder; OmniForge diffs the copy and the user applies what they want.
 *
 * Every argument, environment variable and event shape here comes from the REAL binaries, recorded against a local scripted model
 * (test/fixtures/transcripts: codex 0.163.0, gemini 0.64.0, opencode 1.19.3, aider 0.86.2). Where a choice rests on a CLI's
 * documentation rather than on a recording it says so. What each CLI loads from an untrusted project, and what we do about it:
 *  - Codex trusts the working folder and writes that into CODEX_HOME/config.toml → each run gets a throwaway CODEX_HOME (auth.json is linked in);
 *    `--ignore-user-config` stops the project .codex/config.toml (MCP servers, instructions); `project_doc_max_bytes=0` drops AGENTS.md.
 *  - Gemini CLI always loads GEMINI.md and workspace skills, and the project .env → those are stripped from the copy; `--skip-trust` ignores
 *    the project .gemini/settings.json; OmniForge's own settings live in a private GEMINI_CLI_HOME (a system settings file under /tmp is ignored).
 *  - OpenCode EXECUTES .opencode/plugin(s)/*.js from the project with every isolation flag set → .opencode/ is stripped from the copy.
 *  - Aider always loads .aider.conf.yml and .env from the project (a project .env ran a command in testing) → stripped; HOME is isolated.
 */
import type { AgentEvent } from "./cliagent.js";
import { commandRuleProblem, mcpServerProblem, type McpServerSpec } from "./cliagent.js";

export type AgentCliId = "claude-code" | "codex" | "gemini" | "opencode" | "aider";

export interface AgentCliCaps {
  id: AgentCliId; label: string;
  /** How shell commands can be allowed: exact command allow-list, the CLI's own OS sandbox, or not at all. */
  commands: "allowlist" | "sandbox" | "none";
  mcp: boolean;
  /** How the user signs in with a subscription (shown in the UI), or why an API key is needed. */
  signIn: string;
  /** Needs an API key + model chosen in OmniForge (Aider has no subscription login). */
  needsKey?: boolean;
}

export const AGENT_CLIS: AgentCliCaps[] = [
  { id: "claude-code", label: "Claude Code", commands: "allowlist", mcp: true, signIn: "Run `claude` once in Terminal and sign in with your Claude subscription (or set ANTHROPIC_API_KEY)." },
  { id: "codex", label: "OpenAI Codex CLI", commands: "sandbox", mcp: true, signIn: "Run `codex login` in Terminal and choose “Sign in with ChatGPT” (or `codex login --with-api-key`)." },
  { id: "gemini", label: "Gemini CLI", commands: "allowlist", mcp: true, signIn: "Run `gemini` once in Terminal and choose “Sign in with Google” (or set GEMINI_API_KEY)." },
  { id: "opencode", label: "OpenCode", commands: "allowlist", mcp: true, signIn: "Run `opencode auth login` in Terminal (ChatGPT, GitHub Copilot, API keys…)." },
  { id: "aider", label: "Aider", commands: "none", mcp: false, needsKey: true, signIn: "Aider has no subscription login: choose a model and use one of your OmniForge API keys (OpenRouter, OpenAI, Anthropic…)." },
];

export interface AgentRunPlanInput {
  prompt: string; model?: string; allowedCommands?: string[]; mcpServers?: McpServerSpec[];
  /** The isolated copy the CLI edits, and a private folder beside it for config/state (never inside the copy). */
  work: string; runDir: string;
  /** Aider only: model (litellm name) and the API key env var + value to use. */
  aider?: { model: string; keyEnv?: string; key?: string; apiBase?: string };
  /** Merged into the generated OpenCode config / Gemini settings (custom providers, tests); cannot switch off OmniForge's isolation keys. */
  overlay?: { opencodeConfig?: Record<string, unknown>; geminiSettings?: Record<string, unknown> };
  /** Gemini CLI: the sign-in method from the user's own ~/.gemini/settings.json (e.g. "oauth-personal"), copied into the private settings. */
  geminiAuthType?: string;
  /** Extra arguments (custom provider flags); placed before Codex's positional prompt. */
  extraArgs?: string[];
}
export interface AgentRunPlan {
  args: string[]; env: Record<string, string>; stdin: string;
  /** Files to write before starting, absolute paths inside runDir. */
  files: { path: string; content: string }[];
  /** Codex: the private CODEX_HOME the host prepares (and links the user's auth.json into). */
  codexHome?: string;
  /** Aider: run with an isolated HOME. */
  home?: string;
  /** Gemini CLI: the private home the host prepares (and links the user's sign-in files into). */
  geminiHome?: string;
}

const tomlStr = (s: string) => JSON.stringify(s); // TOML basic strings accept JSON string escapes
const tomlArr = (a: string[]) => `[${a.map(tomlStr).join(",")}]`;
const join = (...p: string[]) => p.join("/").replace(/\/+/g, "/");

function validate(o: AgentRunPlanInput) {
  for (const c of o.allowedCommands ?? []) { const p = commandRuleProblem(c); if (p) throw new Error(`Command “${c}”: ${p}`); }
  for (const m of o.mcpServers ?? []) { const p = mcpServerProblem(m); if (p) throw new Error(`MCP server “${m?.name}”: ${p}`); }
  if (new Set((o.mcpServers ?? []).map((m) => m.name)).size !== (o.mcpServers ?? []).length) throw new Error("MCP server names must be unique.");
  if (!o.prompt.trim()) throw new Error("Describe what the agent should do.");
}

export function planAgentRun(id: Exclude<AgentCliId, "claude-code">, o: AgentRunPlanInput): AgentRunPlan {
  validate(o);
  const cmds = (o.allowedCommands ?? []).map((c) => c.trim()).filter(Boolean); const mcp = o.mcpServers ?? [];
  switch (id) {
    case "codex": {
      const codexHome = join(o.runDir, "codex-home");
      const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--sandbox", "workspace-write", "-c", "project_doc_max_bytes=0",
        // no shell unless the user allowed commands; then Codex's own workspace-write sandbox applies (writes only inside the copy, no network)
        ...(cmds.length ? [] : ["--disable", "shell_tool", "--disable", "unified_exec"]),
        // same tool surface as the other agents: no web access, no goals, nothing that waits for a user who is not there
        "--disable", "goals", "-c", 'web_search="disabled"', "-c", "tools.experimental_request_user_input.enabled=false",
        ...mcp.flatMap((m) => [...("url" in m ? ["-c", `mcp_servers.${m.name}.url=${tomlStr(m.url)}`] : ["-c", `mcp_servers.${m.name}.command=${tomlStr(m.command)}`, "-c", `mcp_servers.${m.name}.args=${tomlArr(m.args ?? [])}`]), "-c", `mcp_servers.${m.name}.default_tools_approval_mode="approve"`]),
        ...(o.model ? ["-m", o.model] : []), ...(o.extraArgs ?? []), "-C", o.work, o.prompt];
      return { args, env: { CODEX_HOME: codexHome }, stdin: "", files: [], codexHome };
    }
    case "gemini": {
      // Gemini CLI ignores a system settings file whose parent folders are world-writable (e.g. /tmp), so OmniForge's settings go into a
      // private GEMINI_CLI_HOME instead (observed with 0.64.0); the host links the user's sign-in files into it.
      const geminiHome = join(o.runDir, "gemini-home");
      const settings: Record<string, unknown> = { ...(o.overlay?.geminiSettings ?? {}),
        ...(o.geminiAuthType ? { security: { auth: { selectedType: o.geminiAuthType } } } : {}),
        advanced: { ignoreLocalEnv: true }, general: { maxAttempts: 3 }, model: { maxSessionTurns: 80 },
        privacy: { usageStatisticsEnabled: false }, telemetry: { enabled: false },
        ...(cmds.length ? { tools: { core: ["read_file", "write_file", "replace", "list_directory", "glob", "grep_search", ...cmds.map((c) => `run_shell_command(${c})`)] } } : { tools: { exclude: ["run_shell_command", "web_fetch", "google_web_search"] } }),
        ...(mcp.length ? { mcpServers: Object.fromEntries(mcp.map((m) => [m.name, "url" in m ? { httpUrl: m.url, trust: true } : { command: m.command, args: m.args ?? [], trust: true }])) } : {}),
      };
      const args = ["-p", o.prompt, "--output-format", "stream-json", "--approval-mode", "yolo", "--skip-trust", "--allowed-mcp-server-names", mcp.length ? mcp.map((m) => m.name).join(",") : "omniforge-none", ...(o.model ? ["-m", o.model] : []), ...(o.extraArgs ?? [])];
      return { args, env: { GEMINI_CLI_HOME: geminiHome, HOME: geminiHome, TMPDIR: o.runDir }, stdin: "", files: [{ path: join(geminiHome, ".gemini", "settings.json"), content: JSON.stringify(settings, null, 2) }], geminiHome };
    }
    case "opencode": {
      const permission: Record<string, unknown> = { edit: "allow", webfetch: "deny", bash: cmds.length ? Object.fromEntries([["*", "deny"], ...cmds.map((c) => [`${c}*`, "allow"])]) : "deny" };
      const config: Record<string, unknown> = { ...(o.overlay?.opencodeConfig ?? {}), $schema: "https://opencode.ai/config.json", permission, ...(mcp.length ? { mcp: Object.fromEntries(mcp.map((m) => [m.name, "url" in m ? { type: "remote", url: m.url, enabled: true } : { type: "local", command: [m.command, ...(m.args ?? [])], enabled: true }])) } : {}) };
      const args = ["run", "--pure", "--format", "json", "--title", "OmniForge agent run", "--dir", o.work, ...(o.model ? ["-m", o.model] : []), ...(o.extraArgs ?? [])];
      return { args, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_PERMISSION: JSON.stringify(permission), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" }, stdin: o.prompt, files: [] };
    }
    case "aider": {
      if (!o.aider?.model) throw new Error("Aider needs a model: choose one of your providers' models.");
      const home = join(o.runDir, "aider-home");
      const args = ["--model", o.aider.model, ...(o.aider.apiBase ? ["--openai-api-base", o.aider.apiBase] : []), "--yes-always", "--no-auto-commits", "--no-dirty-commits", "--no-pretty", "--no-stream", "--no-check-update", "--no-show-release-notes", "--no-analytics", "--no-show-model-warnings",
        "--no-auto-test", "--no-auto-lint", "--no-suggest-shell-commands", "--no-detect-urls", "--no-notifications", "--no-gitignore",
        "--chat-history-file", join(o.runDir, "aider.chat.md"), "--input-history-file", join(o.runDir, "aider.input"), "--llm-history-file", join(o.runDir, "aider.llm.log"), ...(o.extraArgs ?? []), "--message", o.prompt];
      return { args, env: { HOME: home, GIT_AUTHOR_NAME: "OmniForge RE", GIT_AUTHOR_EMAIL: "omniforge@localhost", GIT_COMMITTER_NAME: "OmniForge RE", GIT_COMMITTER_EMAIL: "omniforge@localhost", ...(o.aider.keyEnv && o.aider.key ? { [o.aider.keyEnv]: o.aider.key } : {}), LITELLM_LOCAL_MODEL_COST_MAP: "True" }, stdin: "", files: [], home };
    }
  }
}

/* ---------------- normalisers: one CLI output line → events ---------------- */

export interface AgentNormalizer { line(l: string): AgentEvent[]; end(code: number | null, stderr: string): AgentEvent[] }

const rel = (p: unknown, work?: string) => { const s = typeof p === "string" ? p : ""; if (work && s.startsWith(work.replace(/\/$/, "") + "/")) return s.slice(work.replace(/\/$/, "").length + 1); return s.replace(/^\/(?:private\/)?(?:tmp|var\/folders\/[^/]+\/[^/]+\/T)\/[^/]+\/(?:work\/|project\/)?/, ""); };
const clip = (s: string, n = 140) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const stderrKey = (s: string) => { const lines = s.split("\n").map((l) => l.trim()).filter((l) => l && !/^(?:WARNING: proceeding|YOLO mode|\[STARTUP\]|Loaded cached|Reading additional input)/.test(l)); return lines.find((l) => /error|denied|not logged|sign in|auth|trusted/i.test(l)) ?? lines.at(-1) ?? ""; };
const parse = (l: string): any => { if (!l.trim()) return null; try { return JSON.parse(l); } catch { return null; } };

export function createNormalizer(id: Exclude<AgentCliId, "claude-code">, ctx: { work?: string; mcpServers?: string[] } = {}): AgentNormalizer {
  let done = false; let lastText = ""; let started = false; const seen = new Set<string>();
  const result = (ok: boolean, text: string, extra: Partial<Extract<AgentEvent, { type: "result" }>> = {}): AgentEvent[] => { if (done) return []; done = true; return [{ type: "result", ok, text, ...extra }]; };
  const fail = (code: number | null, stderr: string, what: string) => done ? [] : (done = true, [{ type: "error", message: `${what} exited (code ${code}) without a result${stderrKey(stderr) ? `: ${clip(stderrKey(stderr), 300)}` : "."}` } as AgentEvent]);

  if (id === "codex") return {
    line(l) {
      const j = parse(l); if (!j) return [];
      if (j.type === "thread.started") return [{ type: "init", tools: [] }];
      if (j.type === "error") return [{ type: "notice", text: String(j.message ?? "error") }];
      if (j.type === "turn.failed") return result(false, String(j.error?.message ?? "The turn failed"));
      if (j.type === "turn.completed") { const u = j.usage ?? {}; return result(true, lastText, { turns: undefined, ms: undefined, ...(u.input_tokens !== undefined ? {} : {}) }); }
      const it = j.item; if (!it || (j.type !== "item.started" && j.type !== "item.completed")) return [];
      const first = !seen.has(it.id); seen.add(it.id);
      switch (it.type) {
        case "agent_message": if (j.type === "item.completed" && it.text) { lastText = String(it.text); return [{ type: "text", text: lastText }]; } return [];
        case "error": return j.type === "item.completed" ? [{ type: "notice", text: String(it.message ?? "") }] : [];
        case "file_change": {
          const out: AgentEvent[] = first ? (it.changes ?? []).map((c: any) => { const p = rel(c.path, ctx.work); const verb = c.kind === "add" ? "Write" : c.kind === "delete" ? "Delete" : "Edit"; return { type: "tool", name: verb, summary: `${verb} ${p}`, path: p } as AgentEvent; }) : [];
          if (j.type === "item.completed" && it.status && it.status !== "completed") out.push({ type: "tool_result", ok: false, summary: `File change ${it.status}` });
          return out;
        }
        case "command_execution": {
          const cmd = String(it.command ?? "").replace(/^\/bin\/(?:ba|z)?sh -lc "(.*)"$/s, "$1").replace(/\\"/g, '"');
          const out: AgentEvent[] = first ? [{ type: "tool", name: "Bash", summary: `Run: ${clip(cmd, 100)}` }] : [];
          if (j.type === "item.completed") out.push({ type: "tool_result", ok: it.exit_code === 0, summary: `exit ${it.exit_code ?? "?"}${it.exit_code === 0 ? "" : `: ${clip(String(it.aggregated_output ?? ""), 120)}`}` });
          return out;
        }
        case "mcp_tool_call": {
          const out: AgentEvent[] = first ? [{ type: "tool", name: `mcp__${it.server}__${it.tool}`, summary: `${it.server} (MCP): ${it.tool}` }] : [];
          if (j.type === "item.completed") out.push(it.status === "completed" ? { type: "tool_result", ok: true, summary: `${it.server}/${it.tool} answered` } : { type: "tool_result", ok: false, summary: clip(String(it.error?.message ?? it.status), 160) });
          return out;
        }
        default: return [];
      }
    },
    end(code, stderr) { return done ? [] : code === 0 ? result(true, lastText) : fail(code, stderr, "Codex"); },
  };

  if (id === "gemini") {
    let buf = ""; let lastNotice = "";
    const flush = (): AgentEvent[] => { const t = buf.trim(); buf = ""; if (!t) return []; lastText = t; return [{ type: "text", text: t }]; };
    const verb: Record<string, string> = { write_file: "Write", replace: "Edit", read_file: "Read", run_shell_command: "Bash", glob: "Glob", list_directory: "Glob", grep_search: "Grep", web_fetch: "WebFetch", google_web_search: "WebSearch" };
    return {
      line(l) {
        const j = parse(l); if (!j) return [];
        if (j.type === "init") { started = true; return [{ type: "init", model: typeof j.model === "string" ? j.model : undefined, tools: [] }]; }
        if (j.type === "message" && j.role === "assistant") { buf += String(j.content ?? ""); return []; }
        if (j.type === "tool_use") {
          const name = String(j.tool_name ?? "tool"); const p = rel(j.parameters?.file_path ?? j.parameters?.path, ctx.work);
          const m = /^mcp_(.+)$/.exec(name); const server = m ? (ctx.mcpServers ?? []).find((s) => m[1]!.startsWith(`${s}_`)) : undefined;
          const ev: AgentEvent = server ? { type: "tool", name: `mcp__${server}__${m![1]!.slice(server.length + 1)}`, summary: `${server} (MCP): ${m![1]!.slice(server.length + 1)}` }
            : name === "run_shell_command" ? { type: "tool", name: "Bash", summary: `Run: ${clip(String(j.parameters?.command ?? ""), 100)}` }
            : { type: "tool", name: verb[name] ?? name, summary: `${verb[name] ?? name}${p ? ` ${p}` : ""}`, ...(p ? { path: p } : {}) };
          return [...flush(), ev];
        }
        if (j.type === "tool_result") return j.status === "success" ? [] : [{ type: "tool_result", ok: false, summary: clip(String(j.error?.message ?? j.output ?? "tool failed"), 160) }];
        if (j.type === "error") { lastNotice = String(j.message ?? ""); return [...flush(), { type: "notice", text: lastNotice }]; }
        if (j.type === "result") {
          const out = flush(); const s = j.stats ?? {};
          if (j.status === "success") return [...out, ...result(true, lastText, { ms: typeof s.duration_ms === "number" ? s.duration_ms : undefined })];
          return [...out, ...result(false, String(j.error?.message ?? lastNotice ?? "") || "Gemini CLI reported an error")];
        }
        return [];
      },
      end(code, stderr) {
        const out = flush(); if (done) return out;
        if (code === 41) { done = true; return [...out, { type: "error", message: "Gemini CLI is not signed in. Run `gemini` once in Terminal and choose “Sign in with Google” (or set GEMINI_API_KEY)." }]; }
        if (code === 55) { done = true; return [...out, { type: "error", message: "Gemini CLI refused to run in an untrusted folder (this version may not support --skip-trust)." }]; }
        return [...out, ...(code === 0 && started ? result(true, lastText) : fail(code, stderr, "Gemini CLI"))];
      },
    };
  }

  if (id === "opencode") {
    let stopped = false; let refused = ""; let failed = ""; let tokens = 0;
    const verb: Record<string, string> = { write: "Write", edit: "Edit", read: "Read", bash: "Bash", glob: "Glob", grep: "Grep", webfetch: "WebFetch" };
    return {
      line(l) {
        const j = parse(l); if (!j) return [];
        if (j.type === "step_start") { if (started) return []; started = true; return [{ type: "init", tools: [] }]; }
        if (j.type === "text") { const t = String(j.part?.text ?? ""); if (!t) return []; lastText = t; return [{ type: "text", text: t }]; }
        if (j.type === "tool_use") {
          const t = String(j.part?.tool ?? "tool"); const st = j.part?.state ?? {}; const p = rel(st.input?.filePath ?? st.input?.path, ctx.work);
          const server = (ctx.mcpServers ?? []).find((s) => t.startsWith(`${s}_`));
          const ev: AgentEvent = server ? { type: "tool", name: `mcp__${server}__${t.slice(server.length + 1)}`, summary: `${server} (MCP): ${t.slice(server.length + 1)}` }
            : t === "bash" ? { type: "tool", name: "Bash", summary: `Run: ${clip(String(st.input?.command ?? ""), 100)}` }
            : { type: "tool", name: verb[t] ?? t, summary: `${verb[t] ?? t}${p ? ` ${p}` : ""}`, ...(p ? { path: p } : {}) };
          if (st.status === "error") { const e = String(st.error ?? "tool failed"); if (/rejected permission/i.test(e)) refused = e; return [ev, { type: "tool_result", ok: false, summary: clip(e, 160) }]; }
          return [ev];
        }
        if (j.type === "step_finish") { tokens += Number(j.part?.tokens?.total ?? 0); if (j.part?.reason === "stop") stopped = true; return []; }
        if (j.type === "error") { failed = String(j.error?.data?.message ?? j.error?.name ?? "error"); const sc = j.error?.data?.statusCode; return result(false, `${failed}${sc ? ` (HTTP ${sc})` : ""}`); }
        return [];
      },
      end(code, stderr) {
        if (done) return [];
        if (code === 0 && stopped) return result(true, lastText);
        if (code === 0 && refused) return result(false, `Stopped: a tool call was refused (${refused})`);
        if (code === 0 && started) return result(true, lastText);
        return fail(code, stderr, "OpenCode");
      },
    };
  }

  // Aider prints plain text only and exits 0 even when the model failed, so success is read from its own markers (and the copy's diff).
  let applied = 0; let err = ""; let gaveUp = false; let inHeader = true; const text: string[] = []; let pendingErr = false;
  return {
    line(raw) {
      const l = raw.replace(/\x1b\[[0-9;]*m/g, "");
      if (!started) { started = true; }
      let m: RegExpExecArray | null;
      if ((m = /^Applied edit to (.+)$/.exec(l))) { applied++; const p = rel(m[1]!.trim(), ctx.work); return [{ type: "tool", name: "Edit", summary: `Edit ${p}`, path: p }]; }
      if ((m = /^(?:Creating empty file|Added) (.+?)(?: to the chat\.?)?$/.exec(l)) && inHeader) return [];
      if (/^(?:Update git (?:name|email) with|You can skip this check|Added \.aider|Creating empty file |Added .+ to the chat)/.test(l)) return [];
      if (/^(?:Aider v|Model: |Git repo: |Repo-map: |Detected dumb terminal|Weak model: |Editor model: )/.test(l)) return l.startsWith("Model: ") ? [{ type: "init", model: l.slice(7).replace(/ with .*$/, ""), tools: [] }] : [];
      if ((m = /^litellm\.(\w+): (.*)$/.exec(l))) { err = `${m[1]}: ${m[2]!.replace(/^\w+: /, "")}`; pendingErr = true; inHeader = false; return []; }
      if (pendingErr && l.trim() && !/^Retrying in/.test(l)) { err += ` ${l.trim()}`; if (!/OpenAIException/.test(l)) pendingErr = false; return []; }
      if (/^Retrying in [\d.]+ seconds/.test(l)) { pendingErr = false; return [{ type: "notice", text: `${clip(err, 160)} — retrying` }]; }
      if (/^Only \d+ reflections allowed, stopping\./.test(l)) { gaveUp = true; return [{ type: "notice", text: "Aider gave up: the model's edits did not match the files after 3 attempts" }]; }
      if (/^Tokens: /.test(l)) { inHeader = false; return []; }
      if (l.trim()) { inHeader = false; text.push(l); }
      return [];
    },
    end(code, stderr) {
      if (done) return [];
      const body = text.join("\n").trim().slice(-4000); const out: AgentEvent[] = body ? [{ type: "text", text: body }] : [];
      if (code !== 0) return [...out, ...fail(code, stderr, "Aider")];
      if (err && !applied) return [...out, ...result(false, clip(err, 300))];
      if (gaveUp && !applied) return [...out, ...result(false, "The model's edits did not apply")];
      return [...out, ...result(true, body.split("\n").slice(-3).join(" "))];
    },
  };
}
