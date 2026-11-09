/**
 * AI Chat orchestrator: one model in conversation with the user that can call reverse-engineering tools (analyse a URL, a
 * repository or attached files, search an investigation, read feature specs, start a rebuild) and delegate focused work to
 * subagents that run in parallel. The host (web app, desktop, tests) supplies the side effects through `ReaHost`; this
 * module owns the loop, the tool contracts and the safety rules: everything derived from analysed material is fenced as
 * untrusted, subagents cannot delegate further, and work that writes or spends (rebuilds) goes through the host's approval.
 */
import type { Investigation } from "../schema";
import { collect, type ChatRequest, type Message, type ModelInfo, type Provider, type ToolCall, type ToolDef } from "./types";
import { ROLES } from "./agents";
import { featureBrief, siteBrief, REBUILD_MODES, STACKS, type RebuildMode } from "./plans";
import { relevantContext } from "./retrieval";
import { SECURITY_PREAMBLE, untrusted } from "./untrusted";
import type { AgentRole } from "../schema";

export interface ReaHost {
  /** Crawl a public website (robots-respecting) and return the finished investigation. */
  analyzeUrl(url: string, o: { maxPages?: number; signal?: AbortSignal }): Promise<Investigation>;
  /** Download and analyse a GitHub repository. */
  analyzeRepo?(url: string, o: { signal?: AbortSignal }): Promise<Investigation>;
  /** Analyse the files the user attached to the conversation. */
  analyzeAttachments?(o: { signal?: AbortSignal }): Promise<Investigation>;
  attachments?(): { name: string; bytes: number }[];
  investigations(): Investigation[];
  /** Plan and run a rebuild into the workspace. Hosts must ask the user first; returns a factual summary. */
  rebuild?(o: { investigationId: string; mode: RebuildMode; stackId: string; featureIds?: string[]; improvements?: string; signal?: AbortSignal }): Promise<string>;
}

export type OrchestratorEvent =
  | { type: "text"; text: string } // accumulated text of the current assistant turn
  | { type: "tool"; id: string; name: string; args: Record<string, unknown>; agent?: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string; agent?: string }
  | { type: "subagent"; id: string; role: AgentRole; objective: string; status: "running" | "done" | "failed"; output?: string };

export interface OrchestratorOptions {
  provider: Provider;
  model: ModelInfo;
  /** Earlier turns (user/assistant text only). */
  history: { role: "user" | "assistant"; content: string }[];
  message: string;
  host: ReaHost;
  onEvent?: (e: OrchestratorEvent) => void;
  signal?: AbortSignal;
  maxSteps?: number;
  /** Provider/model for subagents (defaults to the orchestrator's). */
  subagentModel?: { provider: Provider; model: ModelInfo };
  maxParallel?: number;
}

export interface OrchestratorResult { text: string; steps: number; toolCalls: { name: string; ok: boolean }[]; investigations: string[] }

type ToolImpl = { def: ToolDef; run: (args: any, ctx: { signal?: AbortSignal; agent?: string }) => Promise<string> };

const ok = (s: string) => s;
const invLine = (i: Investigation) => `${i.id} · ${i.name} · ${i.status} · ${i.pages.length} pages, ${i.files.length} files, ${i.features.length} features, ${i.endpoints.length} endpoints, ${i.technologies.filter((t) => t.confidence >= 0.6).map((t) => t.name).slice(0, 8).join(", ") || "no confident stack"}`;

/** Tools over the host. `withWrite` adds rebuild (orchestrator only); subagents get the read/analyse set. */
export function reaTools(host: ReaHost, o: { withWrite: boolean; touched: Set<string> }): Record<string, ToolImpl> {
  const find = (id: string) => { const i = host.investigations().find((x) => x.id === id || x.name === id); if (!i) throw new Error(`No investigation “${id}”. Call list_investigations for ids.`); return i; };
  const done = (i: Investigation) => { o.touched.add(i.id); return `Analysis finished: ${invLine(i)}\n\n${siteBrief(i, 9_000)}`; };
  const t: Record<string, ToolImpl> = {
    list_investigations: { def: { name: "list_investigations", description: "List investigations already in this project (id, name, size, stack).", parameters: { type: "object", properties: {}, additionalProperties: false } }, run: async () => host.investigations().map(invLine).join("\n") || "No investigations yet." },
    analyze_url: {
      def: { name: "analyze_url", description: "Crawl a public website the user is allowed to analyse (robots.txt respected, no login/paywall bypass) and return its analysis overview. Takes 10–60 s.", parameters: { type: "object", properties: { url: { type: "string" }, max_pages: { type: "number", description: "1–60, default 20" } }, required: ["url"], additionalProperties: false } },
      run: async (a, c) => { const url = String(a.url ?? "").trim(); if (!/^https?:\/\//i.test(url)) return "Error: url must start with http:// or https://"; return done(await host.analyzeUrl(url, { maxPages: Math.min(60, Math.max(1, Number(a.max_pages) || 20)), signal: c.signal })); },
    },
    investigation_overview: { def: { name: "investigation_overview", description: "Overview of one investigation: stack, pages, features, endpoints, design tokens, page copy, source files.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } }, run: async (a) => { const i = find(String(a.id)); o.touched.add(i.id); return siteBrief(i, 14_000); } },
    search_investigation: { def: { name: "search_investigation", description: "Find the evidence, page text, source code, endpoints and features in an investigation that match a question.", parameters: { type: "object", properties: { id: { type: "string" }, query: { type: "string" } }, required: ["id", "query"], additionalProperties: false } }, run: async (a) => { const i = find(String(a.id)); o.touched.add(i.id); return relevantContext(i, String(a.query ?? ""), { budget: 10_000 }).text || "No matching passages."; } },
    feature_spec: { def: { name: "feature_spec", description: "Behaviour spec, evidence and any recovered source for one feature of an investigation.", parameters: { type: "object", properties: { id: { type: "string" }, feature: { type: "string", description: "feature name or id" } }, required: ["id", "feature"], additionalProperties: false } }, run: async (a) => { const i = find(String(a.id)); const q = String(a.feature ?? "").toLowerCase(); const f = i.features.find((x) => x.id === a.feature || x.name.toLowerCase() === q) ?? i.features.find((x) => x.name.toLowerCase().includes(q)); return f ? featureBrief(i, f, 12_000) : `No feature matching “${a.feature}”. Features: ${i.features.map((x) => x.name).join(", ") || "none"}`; } },
  };
  if (host.analyzeRepo) t.analyze_repo = { def: { name: "analyze_repo", description: "Download and analyse a public GitHub repository (owner/repo or URL): languages, routes, dependencies, features, key source.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } }, run: async (a, c) => done(await host.analyzeRepo!(String(a.url ?? ""), { signal: c.signal })) };
  if (host.analyzeAttachments && host.attachments?.().length) t.analyze_attachments = { def: { name: "analyze_attachments", description: `Analyse the files the user attached (${host.attachments().map((f) => f.name).slice(0, 8).join(", ")}): archives, source folders, OpenAPI/HAR/SBOM, bundles.`, parameters: { type: "object", properties: {}, additionalProperties: false } }, run: async (_a, c) => done(await host.analyzeAttachments!({ signal: c.signal })) };
  if (o.withWrite && host.rebuild) t.rebuild_app = {
    def: { name: "rebuild_app", description: `Plan and build a new implementation of an analysed app into the Code Workspace with OmniForge's build agents. The user is asked to approve first. modes: ${REBUILD_MODES.map((m) => m.id).join(", ")}. stacks: ${STACKS.map((s) => s.id).join(", ")}.`, parameters: { type: "object", properties: { id: { type: "string" }, mode: { type: "string" }, stack: { type: "string" }, features: { type: "array", items: { type: "string" }, description: "feature names (feature-only mode)" }, improvements: { type: "string" } }, required: ["id", "mode", "stack"], additionalProperties: false } },
    run: async (a, c) => {
      const i = find(String(a.id)); const mode = REBUILD_MODES.find((m) => m.id === a.mode)?.id; const stack = STACKS.find((s) => s.id === a.stack)?.id;
      if (!mode) return `Error: unknown mode “${a.mode}”.`; if (!stack) return `Error: unknown stack “${a.stack}”.`;
      const featureIds = Array.isArray(a.features) ? i.features.filter((f) => (a.features as string[]).some((n) => f.name.toLowerCase().includes(String(n).toLowerCase()))).map((f) => f.id) : undefined;
      return host.rebuild!({ investigationId: i.id, mode, stackId: stack, featureIds, improvements: typeof a.improvements === "string" ? a.improvements : undefined, signal: c.signal });
    },
  };
  return t;
}

const SUBAGENT_ROLES: AgentRole[] = ["discovery", "reverse", "architecture", "review", "uiux", "testing"];

function delegateTool(o: OrchestratorOptions, tools: Record<string, ToolImpl>, emit: (e: OrchestratorEvent) => void): ToolImpl {
  return {
    def: { name: "delegate", description: `Run focused subagents in parallel and get their reports. Use for independent pieces of work (e.g. compare two analyses, review an architecture, deep-dive one feature). Each subagent can use the analysis tools but cannot delegate. roles: ${SUBAGENT_ROLES.join(", ")}.`, parameters: { type: "object", properties: { tasks: { type: "array", maxItems: 6, items: { type: "object", properties: { role: { type: "string" }, objective: { type: "string" } }, required: ["role", "objective"] } } }, required: ["tasks"], additionalProperties: false } },
    run: async (a, c) => {
      const list: { id: string; role: AgentRole; objective: string }[] = (Array.isArray(a.tasks) ? a.tasks : []).slice(0, 6).map((t: any, n: number) => ({ id: `sub${n + 1}`, role: (SUBAGENT_ROLES.includes(t?.role) ? t.role : "reverse") as AgentRole, objective: String(t?.objective ?? "").slice(0, 4_000) })).filter((t: { objective: string }) => t.objective);
      if (!list.length) return "Error: give at least one task with a role and an objective.";
      const sub = o.subagentModel ?? { provider: o.provider, model: o.model };
      const results: string[] = new Array(list.length);
      let next = 0;
      const worker = async () => {
        while (next < list.length) {
          const k = next++; const t = list[k]!;
          emit({ type: "subagent", id: t.id, role: t.role, objective: t.objective, status: "running" });
          try {
            const r = await loop({ provider: sub.provider, model: sub.model, system: `${SECURITY_PREAMBLE}\n\nYou are the ${ROLES[t.role].label}, a subagent of OmniForge's orchestrator. ${ROLES[t.role].system}\nUse the analysis tools to ground every claim; cite investigation ids and evidence ids. Reply with a concise, factual report — it goes to the orchestrator, not the user.`, messages: [{ role: "user", content: t.objective }], tools, signal: c.signal, maxSteps: 10, agent: t.id, emit });
            results[k] = `## ${t.id} · ${ROLES[t.role].label}\n${r.text || "(no report)"}`;
            emit({ type: "subagent", id: t.id, role: t.role, objective: t.objective, status: "done", output: r.text });
          } catch (e) {
            if ((e as Error).name === "AbortError") throw e;
            results[k] = `## ${t.id} · ${ROLES[t.role].label}\nFailed: ${(e as Error).message}`;
            emit({ type: "subagent", id: t.id, role: t.role, objective: t.objective, status: "failed", output: (e as Error).message });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(o.maxParallel ?? 3, list.length) }, worker));
      return results.join("\n\n");
    },
  };
}

/** One tool-using conversation loop. Returns the final text; tool output goes back to the model as tool messages. */
async function loop(p: { provider: Provider; model: ModelInfo; system: string; messages: Message[]; tools: Record<string, ToolImpl>; signal?: AbortSignal; maxSteps: number; agent?: string; emit: (e: OrchestratorEvent) => void; trace?: { name: string; ok: boolean }[] }): Promise<{ text: string; steps: number }> {
  const defs = Object.values(p.tools).map((t) => t.def);
  let text = ""; let step = 0; let maxTokens = Math.min(Math.max(p.model.maxOutput ?? 8192, 4096), 16_384);
  for (; step < p.maxSteps; step++) {
    if (p.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const req: ChatRequest = { model: p.model.id, system: p.system, messages: p.messages, tools: defs.length ? defs : undefined, temperature: 0.3, signal: p.signal, maxTokens };
    let acc = "";
    const r = await collect((async function* () { for await (const e of p.provider.chat(req)) { if (e.type === "text" && !p.agent) { acc += e.text; p.emit({ type: "text", text: acc }); } yield e; } })());
    p.messages.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls.length ? r.toolCalls : undefined });
    if (!r.toolCalls.length) {
      if (r.finish === "length" && step + 1 < p.maxSteps) { maxTokens = Math.min(maxTokens * 2, 64_000); p.messages.push({ role: "user", content: "Your reply was cut off at the output limit. Continue exactly where you stopped." }); text += r.text; continue; }
      text += r.text; return { text: text.trim(), steps: step + 1 };
    }
    const calls: ToolCall[] = r.toolCalls;
    const outs = await Promise.all(calls.map(async (call) => {
      const tool = p.tools[call.name];
      p.emit({ type: "tool", id: call.id, name: call.name, args: call.args, agent: p.agent });
      let out: string; let good = true;
      if (!tool) { out = `Error: unknown tool ${call.name}.`; good = false; }
      else if (call.args && "_raw" in call.args) { out = "Error: the arguments were not valid JSON (possibly cut off). Try again with shorter arguments."; good = false; }
      else try { out = await tool.run(call.args ?? {}, { signal: p.signal, agent: p.agent }); good = !/^Error:/.test(out); }
      catch (e) { if ((e as Error).name === "AbortError") throw e; out = `Error: ${(e as Error).message}`; good = false; }
      p.trace?.push({ name: call.name, ok: good });
      p.emit({ type: "tool_result", id: call.id, name: call.name, ok: good, summary: out.split("\n").find((l) => l.trim() && !l.startsWith("<<<"))?.replace(/^#+\s*/, "").slice(0, 200) ?? "", agent: p.agent });
      return { call, out };
    }));
    for (const { call, out } of outs) p.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: ok(out) });
  }
  return { text: (text || "I stopped after the maximum number of steps without a final answer.").trim(), steps: step };
}

export const ORCHESTRATOR_SYSTEM = `You are OmniForge's orchestrator, an expert in reverse engineering software and rebuilding it. You chat with the user and do the work end to end with tools:
- When the user gives a website URL, a GitHub repository or attached files, analyse it first (analyze_url / analyze_repo / analyze_attachments) instead of guessing.
- Ground answers in the analysis: use investigation_overview, search_investigation and feature_spec, and cite investigation ids and evidence ids.
- Separate what was OBSERVED or RECOVERED from what you INFER. Say plainly when the evidence does not answer a question.
- For independent sub-questions, use delegate to run subagents in parallel, then synthesise their reports.
- Only rebuild (rebuild_app) when the user asks for it; the user approves before anything is built.
- Only analyse what the user is allowed to analyse; never attempt to bypass logins, paywalls, CAPTCHAs or robots.txt.
Be concise and concrete. Use Markdown.`;

/** Run one orchestrator turn: the user's message → tool calls / subagents → the final answer. */
export async function runOrchestrator(o: OrchestratorOptions): Promise<OrchestratorResult> {
  const emit = o.onEvent ?? (() => {});
  const touched = new Set<string>();
  const base = reaTools(o.host, { withWrite: true, touched });
  const subTools = reaTools(o.host, { withWrite: false, touched });
  const tools = { ...base, delegate: delegateTool(o, subTools, emit) };
  const known = o.host.investigations().slice(0, 30).map(invLine).join("\n");
  const att = o.host.attachments?.() ?? [];
  const system = `${SECURITY_PREAMBLE}\n\n${ORCHESTRATOR_SYSTEM}\n\nInvestigations in this project:\n${known || "(none yet)"}${att.length ? `\n\nAttached files: ${att.map((f) => `${f.name} (${f.bytes} bytes)`).join(", ")}` : ""}`;
  const messages: Message[] = [...o.history.slice(-16).map((m) => ({ role: m.role, content: m.content }) as Message), { role: "user", content: o.message }];
  const trace: { name: string; ok: boolean }[] = [];
  const r = await loop({ provider: o.provider, model: o.model, system, messages, tools, signal: o.signal, maxSteps: o.maxSteps ?? 16, emit, trace });
  return { text: r.text, steps: r.steps, toolCalls: trace, investigations: [...touched] };
}

/** Single-model chat with optional attached text (fenced as untrusted). */
export function singleChatRequest(o: { model: string; system?: string; history: { role: "user" | "assistant"; content: string }[]; message: string; attachments?: { name: string; text: string }[] }): ChatRequest {
  const files = (o.attachments ?? []).map((f) => untrusted(`attachment:${f.name}`, f.text, 40_000)).join("\n\n");
  return { model: o.model, system: `${SECURITY_PREAMBLE}\n\n${o.system ?? "You are a helpful expert assistant inside OmniForge RE, a reverse-engineering and app-rebuilding studio."}`, messages: [...o.history.slice(-20).map((m) => ({ role: m.role, content: m.content }) as Message), { role: "user", content: files ? `${files}\n\n${o.message}` : o.message }] };
}
