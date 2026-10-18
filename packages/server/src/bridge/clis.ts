/**
 * AI coding CLI adapters. Nothing is assumed about a CLI's interface: each
 * adapter lists candidate invocation methods, and the one used is chosen by
 * probing the installed version's own --help output. If none match, the CLI is
 * reported as "unsupported invocation" instead of being driven blindly.
 */
import { spawn } from "node:child_process";
import { collect, ProviderError, type ChatEvent, type ChatRequest, type ModelInfo, type Provider, type ProviderStatus } from "@omniforge/core";
import { exec, which } from "./detect.js";
import { sanitizedEnv } from "./jobs.js";

type Parse = "claude-stream-json" | "jsonl-generic" | "json" | "text";
export interface Method { id: string; probe: { args: string[]; needs: string[] }; build: (o: { prompt: string; model?: string; cwd?: string; permissionMode?: string }) => string[]; stdin?: boolean; parse: Parse; note?: string }
export interface CliAdapter { id: string; name: string; bins: string[]; versionArgs: string[]; vendor: string; agentic: boolean; methods: Method[]; authCheck?: { args: string[]; ok: (r: { code: number; out: string }) => boolean }; install: string; docs?: string }

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
    methods: [
      { id: "exec-json", probe: { args: ["exec", "--help"], needs: ["--json"] }, parse: "jsonl-generic", build: ({ prompt, model }) => ["exec", "--json", "--skip-git-repo-check", ...(model ? ["--model", model] : []), prompt] },
      { id: "exec", probe: { args: ["--help"], needs: ["exec"] }, parse: "text", build: ({ prompt, model }) => ["exec", ...(model ? ["--model", model] : []), prompt] },
    ],
  },
  {
    id: "gemini", name: "Gemini CLI", bins: ["gemini"], versionArgs: ["--version"], vendor: "Google", agentic: true, install: "npm install -g @google/gemini-cli",
    methods: [
      { id: "prompt-json", probe: { args: ["--help"], needs: ["--prompt", "--output-format"] }, parse: "json", build: ({ prompt, model }) => ["--prompt", prompt, "--output-format", "json", ...(model ? ["--model", model] : [])] },
      { id: "prompt", probe: { args: ["--help"], needs: ["--prompt"] }, parse: "text", build: ({ prompt, model }) => ["--prompt", prompt, ...(model ? ["--model", model] : [])] },
    ],
  },
  {
    id: "opencode", name: "OpenCode", bins: ["opencode"], versionArgs: ["--version"], vendor: "SST", agentic: true, install: "npm install -g opencode-ai",
    methods: [{ id: "run", probe: { args: ["--help"], needs: ["run"] }, parse: "text", build: ({ prompt, model }) => ["run", ...(model ? ["--model", model] : []), prompt] }],
  },
  {
    id: "aider", name: "Aider", bins: ["aider"], versionArgs: ["--version"], vendor: "Aider", agentic: true, install: "pipx install aider-chat",
    methods: [{ id: "message", probe: { args: ["--help"], needs: ["--message"] }, parse: "text", build: ({ prompt, model }) => ["--message", prompt, "--yes-always", "--no-pretty", "--no-stream", "--no-auto-commits", ...(model ? ["--model", model] : [])], note: "Edits files in the working directory" }],
  },
];

export type CliStatus = "ready" | "installed-unauthenticated" | "unsupported-invocation" | "not-installed" | "needs-configuration";
export interface CliInfo { id: string; name: string; vendor: string; status: CliStatus; path?: string; version?: string; method?: string; methods: { id: string; supported: boolean; missing: string[] }[]; authenticated?: boolean | "unknown"; detail?: string; install: string; agentic: boolean; verified?: { ok: boolean; ms: number; reply?: string; error?: string } }

export async function probeCli(a: CliAdapter): Promise<CliInfo> {
  const base = { id: a.id, name: a.name, vendor: a.vendor, install: a.install, agentic: a.agentic, methods: [] as CliInfo["methods"] };
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
  const child = spawn(info.path, args, { cwd: o.cwd, env: sanitizedEnv({ ...(process.env.ANTHROPIC_API_KEY ? {} : {}), ...o.env, ...passEnvFor(a.id) }), detached: true, stdio: [method.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
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
  child.on("close", (c) => { if (buf.trim()) { method.parse === "json" ? handleLine(buf.replace(/\n/g, " ")) : handleLine(buf); } buf = ""; code = c; ended = true; wake?.(); });
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
