/**
 * AI coding CLI adapters. Nothing is assumed about a CLI's interface: each
 * adapter lists candidate invocation methods, and the one used is chosen by
 * probing the installed version's own --help output. If none match, the CLI is
 * reported as "unsupported invocation" instead of being driven blindly.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collect, createNormalizer, ProviderError, type AgentEvent, type ChatEvent, type ChatRequest, type ModelInfo, type Provider, type ProviderStatus } from "@omniforge/core";
import { exec, which } from "./detect.js";
import { sanitizedEnv } from "./jobs.js";

type Parse = "claude-stream-json" | "agent" | "jsonl-generic" | "json" | "text";
export interface Method { id: string; probe: { args: string[]; needs: string[] }; build: (o: { prompt: string; model?: string; cwd?: string; permissionMode?: string }) => string[]; stdin?: boolean; parse: Parse; note?: string; /** extra environment for this method (read-only permissions etc.) */ env?: Record<string, string> }
export interface CliAdapter { id: string; name: string; bins: string[]; versionArgs: string[]; vendor: string; agentic: boolean; methods: Method[]; authCheck?: { args: string[]; ok: (r: { code: number; out: string }) => boolean }; /** the CLI's own sign-in command, run in Terminal for the user */ login?: string[]; /** agent mode only, never a chat provider */ agentOnly?: boolean; /** sign-in check that needs no command */ authProbe?: () => boolean; install: string; docs?: string }

export const ADAPTERS: CliAdapter[] = [
  {
    id: "claude-code", name: "Claude Code", bins: ["claude"], versionArgs: ["--version"], vendor: "Anthropic", agentic: true, install: "npm install -g @anthropic-ai/claude-code",
    authCheck: { args: ["auth", "status"], ok: (r) => r.code === 0 && !/not logged in|no.*auth/i.test(r.out) },
    methods: [
      { id: "print-stream-json", probe: { args: ["--help"], needs: ["--print", "--output-format", "--verbose"] }, stdin: true, parse: "claude-stream-json", build: ({ model, permissionMode }) => ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--permission-mode", permissionMode ?? "default", ...(model ? ["--model", model] : [])] },
      { id: "print-text", probe: { args: ["--help"], needs: ["--print"] }, stdin: true, parse: "text", build: ({ model }) => ["-p", ...(model ? ["--model", model] : [])] },
    ],
  },
  {
    id: "codex", name: "OpenAI Codex CLI", bins: ["codex"], versionArgs: ["--version"], vendor: "OpenAI", agentic: true, install: "npm install -g @openai/codex",
    // `codex login status` exits 1 with "Not logged in" (recorded, 0.163.0)
    authCheck: { args: ["login", "status"], ok: (r) => r.code === 0 && /logged in/i.test(r.out) && !/not logged in/i.test(r.out) },
    login: ["codex", "login"],
    methods: [
      // chat: read-only sandbox, no project config/AGENTS.md, events parsed by the recorded normaliser
      { id: "exec-json", probe: { args: ["exec", "--help"], needs: ["--json", "--sandbox", "--ignore-user-config"] }, parse: "agent", build: ({ prompt, model }) => ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"', ...(model ? ["-m", model] : []), prompt] },
    ],
  },
  {
    id: "gemini", name: "Gemini CLI", bins: ["gemini"], versionArgs: ["--version"], vendor: "Google", agentic: true, install: "npm install -g @google/gemini-cli",
    login: ["gemini"], // no login subcommand: the first interactive run offers "Sign in with Google"
    // signed in = a cached Google login, or an API key / Vertex set up (paths and names only; secrets are never read)
    authProbe: () => fs.existsSync(path.join(os.homedir(), ".gemini", "oauth_creds.json")) || fs.existsSync(path.join(os.homedir(), ".gemini", "gemini-credentials.json")) || !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_USE_VERTEXAI),
    methods: [
      // chat: plan (read-only) approval mode; trust skipped so project settings are not loaded (recorded, 0.64.0)
      { id: "prompt-stream-json", probe: { args: ["--help"], needs: ["--output-format", "--approval-mode", "--skip-trust"] }, parse: "agent", build: ({ prompt, model }) => ["-p", prompt, "--output-format", "stream-json", "--approval-mode", "plan", "--skip-trust", ...(model ? ["-m", model] : [])] },
    ],
  },
  {
    id: "opencode", name: "OpenCode", bins: ["opencode"], versionArgs: ["--version"], vendor: "SST", agentic: true, install: "npm install -g opencode-ai",
    // `opencode auth list` always exits 0; it prints "— N credentials"
    authCheck: { args: ["auth", "list"], ok: (r) => /[1-9]\d* credentials?/.test(r.out.replace(/\x1b\[[0-9;]*m/g, "")) },
    login: ["opencode", "auth", "login"],
    methods: [
      // chat: prompt on stdin (positional prompts arrive quoted), edits/shell/web denied, project config off (recorded, 1.19.3)
      { id: "run-json", probe: { args: ["run", "--help"], needs: ["--format"] }, stdin: true, parse: "agent", build: ({ model }) => ["run", "--pure", "--format", "json", "--title", "OmniForge chat", ...(model ? ["-m", model] : [])], env: { OPENCODE_PERMISSION: JSON.stringify({ edit: "deny", bash: "deny", webfetch: "deny" }), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" } },
    ],
  },
  {
    id: "aider", name: "Aider", bins: ["aider"], versionArgs: ["--version"], vendor: "Aider", agentic: true, install: "pipx install aider-chat", agentOnly: true,
    // Aider has no subscription login and needs a model + key chosen in OmniForge; it is offered in agent mode only (not as a chat provider)
    methods: [{ id: "message", probe: { args: ["--help"], needs: ["--message", "--yes-always", "--no-auto-commits"] }, parse: "text", build: ({ prompt }) => ["--message", prompt] }],
  },
];

export type CliStatus = "ready" | "installed-unauthenticated" | "unsupported-invocation" | "not-installed" | "needs-configuration";
export interface CliInfo { id: string; name: string; vendor: string; status: CliStatus; path?: string; version?: string; method?: string; methods: { id: string; supported: boolean; missing: string[] }[]; authenticated?: boolean | "unknown"; detail?: string; install: string; agentic: boolean; agentOnly?: boolean; canLogin?: boolean; verified?: { ok: boolean; ms: number; reply?: string; error?: string } }

export async function probeCli(a: CliAdapter): Promise<CliInfo> {
  const base = { id: a.id, name: a.name, vendor: a.vendor, install: a.install, agentic: a.agentic, agentOnly: !!a.agentOnly, canLogin: !!a.login, methods: [] as CliInfo["methods"] };
  const bin = a.bins.map(which).find(Boolean) ?? null;
  if (!bin) return { ...base, status: "not-installed" };
  const v = await exec(bin, a.versionArgs, { timeoutMs: 8000 });
  const version = (v.stdout || v.stderr).match(/\d+\.\d+(?:\.\d+)?[\w.+-]*/)?.[0];
  if (v.code !== 0 && !version) return { ...base, path: bin, status: "needs-configuration", detail: (v.stderr || v.stdout).trim().slice(0, 140) };
  const helpCache = new Map<string, string>();
  const methods: CliInfo["methods"] = [];
  let chosen: string | undefined;
  for (const m of a.methods) {
    const key = m.probe.args.join(" ");
    if (!helpCache.has(key)) { const h = await exec(bin, m.probe.args, { timeoutMs: 8000 }); helpCache.set(key, h.stdout + "\n" + h.stderr); }
    const text = helpCache.get(key)!;
    const missing = m.probe.needs.filter((n) => !text.includes(n));
    methods.push({ id: m.id, supported: missing.length === 0, missing });
    if (!missing.length && !chosen) chosen = m.id;
  }
  let authenticated: CliInfo["authenticated"] = "unknown";
  if (a.authCheck) { const r = await exec(bin, a.authCheck.args, { timeoutMs: 10_000 }); authenticated = a.authCheck.ok({ code: r.code, out: r.stdout + r.stderr }); }
  else if (a.authProbe) authenticated = a.authProbe();
  if (!chosen) return { ...base, path: bin, version, methods, authenticated, status: "unsupported-invocation", detail: "This version's --help does not expose a non-interactive mode this app knows how to drive." };
  return { ...base, path: bin, version, methods, method: chosen, authenticated, status: authenticated === false ? "installed-unauthenticated" : "ready", detail: authenticated === "unknown" ? "Authentication status is not queryable; run the connectivity test." : undefined };
}

export const detectClis = () => Promise.all(ADAPTERS.map(probeCli));

/* ---------------- running ---------------- */

export interface RunOptions { prompt: string; model?: string; cwd?: string; timeoutMs?: number; signal?: AbortSignal; permissionMode?: string; env?: Record<string, string> }

/** Kill the whole process group (CLIs spawn helpers). */
function killGroup(pid: number | undefined) { if (!pid) return; try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ } setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }, 3000).unref(); }

export async function* runCli(a: CliAdapter, info: CliInfo, o: RunOptions): AsyncGenerator<ChatEvent> {
  const method = a.methods.find((m) => m.id === info.method);
  if (!info.path || !method) throw new ProviderError(`${a.name} is not available for non-interactive use (${info.status}).`, undefined, a.id);
  if (!method.stdin && o.prompt.length > 100_000) throw new ProviderError(`${a.name} takes the prompt as an argument; ${o.prompt.length} characters is too long for this method.`, undefined, a.id);
  const args = method.build({ prompt: o.prompt, model: o.model, cwd: o.cwd, permissionMode: o.permissionMode });
  const child = spawn(info.path, args, { cwd: o.cwd, env: sanitizedEnv({ ...o.env, ...passEnvFor(a.id), ...method.env }), detached: true, stdio: [method.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
  const norm = method.parse === "agent" && a.id !== "claude-code" && a.id !== "aider" ? createNormalizer(a.id as "codex" | "gemini" | "opencode", { work: o.cwd }) : null; let agentError: string | null = null;
  const fromAgent = (evs: AgentEvent[]) => { for (const e of evs) { if (e.type === "text") { push({ type: "text", text: (emitted ? "\n" : "") + e.text }); emitted = true; } else if (e.type === "result" && !e.ok) agentError = e.text || "the CLI reported an error"; else if (e.type === "error") agentError = e.message; } };
  if (method.stdin) { child.stdin!.end(o.prompt); }
  const timer = o.timeoutMs ? setTimeout(() => killGroup(child.pid), o.timeoutMs) : undefined;
  const onAbort = () => killGroup(child.pid);
  o.signal?.addEventListener("abort", onAbort, { once: true });
  let stderr = "";
  child.stderr!.on("data", (d) => { stderr += d.toString(); if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
  const queue: ChatEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let code: number | null = null;
  let buf = "";
  let emitted = false;
  let finalText = "";
  const push = (e: ChatEvent) => { queue.push(e); wake?.(); };
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    if (norm) return fromAgent(norm.line(line));
    if (method.parse === "text") { push({ type: "text", text: line + "\n" }); emitted = true; return; }
    let j: any;
    try { j = JSON.parse(line); } catch { if (method.parse !== "json") { push({ type: "text", text: line + "\n" }); emitted = true; } return; }
    if (method.parse === "claude-stream-json") {
      if (j.type === "assistant") for (const c of j.message?.content ?? []) { if (c.type === "text" && c.text) { push({ type: "text", text: c.text }); emitted = true; finalText += c.text; } }
      else if (j.type === "result") { if (typeof j.result === "string" && !finalText) { push({ type: "text", text: j.result }); emitted = true; } const u = j.usage ?? {}; push({ type: "usage", input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 }); if (j.is_error) push({ type: "text", text: `\n[${a.name} reported an error: ${String(j.result ?? j.subtype ?? "unknown").slice(0, 300)}]` }); }
    } else if (method.parse === "jsonl-generic") {
      const text = j.msg?.message ?? j.item?.text ?? j.message ?? j.text ?? j.content;
      if (typeof text === "string" && text) { push({ type: "text", text: text + "\n" }); emitted = true; }
    } else if (method.parse === "json") {
      const text = j.response ?? j.result ?? j.text;
      if (typeof text === "string") { push({ type: "text", text }); emitted = true; }
    }
  };
  child.stdout!.on("data", (d) => {
    const s = d.toString("utf8");
    if (method.parse === "json") { buf += s; return; }
    buf += s;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.on("close", (c) => { if (buf.trim()) { method.parse === "json" ? handleLine(buf.replace(/\n/g, " ")) : handleLine(buf); } buf = ""; code = c; if (norm) fromAgent(norm.end(c, stderr)); ended = true; wake?.(); });
  child.on("error", (e) => { stderr += String(e); ended = true; wake?.(); });
  try {
    while (!ended || queue.length) {
      if (queue.length) { yield queue.shift()!; continue; }
      await new Promise<void>((r) => { wake = r; });
    }
  } finally {
    if (timer) clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    if (!ended) killGroup(child.pid);
  }
  if (o.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (agentError && !emitted) throw new ProviderError(`${a.name}: ${agentError}`, undefined, a.id);
  if (code !== 0 && !emitted) throw new ProviderError(`${a.name} exited with code ${code}: ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300) || "no output"}`, undefined, a.id);
  yield { type: "done", finish: code === 0 ? "stop" : "error" };
}

/** CLIs authenticate with their own stored login; pass through only their own documented key variables. */
export function passEnvFor(id: string): Record<string, string> {
  const map: Record<string, string[]> = { "claude-code": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"], codex: ["OPENAI_API_KEY", "CODEX_HOME"], gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT"], opencode: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"], aider: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] };
  const out: Record<string, string> = {};
  for (const k of map[id] ?? []) if (process.env[k]) out[k] = process.env[k]!;
  return out;
}

/** Benign connectivity test: asks for a fixed token and verifies the reply. */
export async function testCli(a: CliAdapter, info: CliInfo, timeoutMs = 90_000): Promise<NonNullable<CliInfo["verified"]>> {
  const t = Date.now();
  try {
    const r = await collect(runCli(a, info, { prompt: "Reply with exactly the single word: PONG", timeoutMs, cwd: process.cwd() }));
    return { ok: /PONG/i.test(r.text), ms: Date.now() - t, reply: r.text.trim().slice(0, 120) };
  } catch (e) { return { ok: false, ms: Date.now() - t, error: (e as Error).message }; }
}

/** Adapt a CLI to the provider interface so the router/agents can use it like any model. */
export class CliProvider implements Provider {
  readonly kind = "openai-compat" as const;
  readonly local = false;
  constructor(private a: CliAdapter, private info: CliInfo, private defaults: { cwd?: string } = {}) {}
  get id() { return `cli:${this.a.id}`; }
  get label() { return this.a.name; }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: this.a.id, name: `${this.a.name} (agentic CLI)`, provider: this.id, capabilities: ["chat", "code", "reasoning"], capabilitySource: "reported", local: false, family: this.a.vendor }];
  }
  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent> {
    const text = (m: ChatRequest["messages"][number]) => (typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p: any) => p.text).join("\n"));
    const prompt = [req.system ? `[System]\n${req.system}\n` : "", ...req.messages.map((m) => `[${m.role}]\n${text(m)}`)].filter(Boolean).join("\n\n");
    yield* runCli(this.a, this.info, { prompt, cwd: this.defaults.cwd, signal: req.signal, timeoutMs: 600_000, model: req.model && req.model !== this.a.id ? req.model : undefined });
  }
  async health(): Promise<ProviderStatus> {
    const t = Date.now();
    const i = await probeCli(this.a);
    return { ok: i.status === "ready", latencyMs: Date.now() - t, version: i.version, error: i.status === "ready" ? undefined : `${this.a.name}: ${i.status}${i.detail ? ` — ${i.detail}` : ""}` };
  }
}
