/** Ollama native API adapter (/api/chat, /api/tags, /api/show, /api/embed, /api/ps, /api/version). */
import { finalize, parseParamsB } from "../models.js";
import { ndjson } from "../stream.js";
import { ProviderError, type Capability, type ChatEvent, type ChatRequest, type ModelInfo, type Provider, type ProviderConfig, type ProviderStatus } from "../types.js";
import { http } from "./shared.js";
import { mergeManual } from "./openai.js";

export function toOllamaMessages(req: ChatRequest) {
  const out: any[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "tool") { out.push({ role: "tool", content: typeof m.content === "string" ? m.content : "", tool_name: m.name }); continue; }
    const text = typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p: any) => p.text).join("\n");
    const images = typeof m.content === "string" ? [] : m.content.filter((p) => p.type === "image").map((p: any) => p.data);
    const msg: any = { role: m.role, content: text };
    if (images.length) msg.images = images;
    if (m.toolCalls?.length) msg.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } }));
    out.push(msg);
  }
  return out;
}

const CAP_MAP: Record<string, Capability> = { completion: "chat", tools: "tools", vision: "vision", embedding: "embeddings", thinking: "reasoning", insert: "code" };

export class OllamaProvider implements Provider {
  readonly kind = "ollama" as const;
  constructor(readonly cfg: ProviderConfig, private fetchImpl: typeof fetch = globalThis.fetch) {}
  get id() { return this.cfg.id; }
  get label() { return this.cfg.label; }
  get local() { return true; }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const tags: any = await (await http(this.cfg, "api/tags", { method: "GET", signal }, this.fetchImpl)).json();
    let running = new Set<string>();
    try {
      const ps: any = await (await http(this.cfg, "api/ps", { method: "GET", signal }, this.fetchImpl)).json();
      running = new Set((ps.models ?? []).map((m: any) => m.name));
    } catch { /* /api/ps is optional on older servers */ }
    const out: ModelInfo[] = [];
    for (const m of tags.models ?? []) {
      let ctx: number | undefined;
      let caps: Capability[] | undefined;
      let paramsB = m.details?.parameter_size ? parseParamsB(String(m.details.parameter_size).toLowerCase()) : undefined;
      try {
        const show: any = await (await http(this.cfg, "api/show", { method: "POST", json: { model: m.name }, signal }, this.fetchImpl)).json();
        const info = show.model_info ?? {};
        const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
        if (key) ctx = Number(info[key]);
        if (info["general.parameter_count"]) paramsB = Number(info["general.parameter_count"]) / 1e9;
        if (Array.isArray(show.capabilities)) {
          caps = [...new Set(show.capabilities.map((c: string) => CAP_MAP[c]).filter(Boolean))] as Capability[];
          if (caps.includes("chat") && !caps.includes("json")) caps.push("json");
        }
      } catch { /* show is best-effort per model */ }
      out.push(finalize({
        id: m.name, name: m.name, provider: this.id, local: true, contextWindow: ctx, paramsB, quantization: m.details?.quantization_level,
        sizeBytes: m.size, capabilities: caps, family: m.details?.family, loaded: running.has(m.name), modified: m.modified_at,
      }));
    }
    return mergeManual(this.cfg, out, true);
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent> {
    const body: any = { model: req.model, messages: toOllamaMessages(req), stream: true };
    const options: Record<string, unknown> = {};
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (req.maxTokens) options.num_predict = req.maxTokens;
    if (this.cfg.contextLimit) options.num_ctx = this.cfg.contextLimit;
    if (Object.keys(options).length) body.options = options;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (req.json) body.format = typeof req.json === "object" ? req.json : "json";
    if (req.reasoning) body.think = req.reasoning === "off" ? false : req.reasoning;
    const res = await http(this.cfg, "api/chat", { method: "POST", json: body, signal: req.signal }, this.fetchImpl);
    let sawTool = false;
    let n = 0;
    for await (const j of ndjson(res, req.signal)) {
      if (j.error) throw new ProviderError(`${this.cfg.label}: ${j.error}`, undefined, this.id);
      const msg = j.message;
      if (msg?.thinking) yield { type: "thinking", text: msg.thinking };
      if (msg?.content) yield { type: "text", text: msg.content };
      for (const tc of msg?.tool_calls ?? []) {
        sawTool = true;
        const args = typeof tc.function?.arguments === "string" ? safeJson(tc.function.arguments) : (tc.function?.arguments ?? {});
        yield { type: "tool_call", call: { id: tc.id ?? `call_${n++}`, name: tc.function?.name, args } };
      }
      if (j.done) {
        yield { type: "usage", input: j.prompt_eval_count ?? 0, output: j.eval_count ?? 0 };
        yield { type: "done", finish: sawTool ? "tool_calls" : j.done_reason === "length" ? "length" : "stop" };
        return;
      }
    }
    yield { type: "done", finish: "other" };
  }

  async embed(model: string, input: string[], signal?: AbortSignal): Promise<number[][]> {
    const j: any = await (await http(this.cfg, "api/embed", { method: "POST", json: { model, input }, signal }, this.fetchImpl)).json();
    return j.embeddings ?? [];
  }

  async health(signal?: AbortSignal): Promise<ProviderStatus> {
    const t = Date.now();
    try {
      const v: any = await (await http(this.cfg, "api/version", { method: "GET", signal }, this.fetchImpl)).json();
      const tags: any = await (await http(this.cfg, "api/tags", { method: "GET", signal }, this.fetchImpl)).json();
      return { ok: true, latencyMs: Date.now() - t, version: v.version, models: (tags.models ?? []).length };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t, error: (e as Error).message };
    }
  }
}

function safeJson(s: string) { try { return JSON.parse(s); } catch { return { _raw: s }; } }
