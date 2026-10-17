/**
 * OpenAI-compatible adapter: OpenAI, xAI (Grok), Moonshot/Kimi, OpenRouter,
 * Gemini's OpenAI-compat endpoint, LM Studio, llama.cpp server, MLX server,
 * vLLM, Unsloth Studio and any other /v1/chat/completions server.
 */
import { finalize, guessCapabilities } from "../models.js";
import { sseLines } from "../stream.js";
import { ProviderError, type ChatEvent, type ChatRequest, type Message, type ModelInfo, type Provider, type ProviderConfig, type ProviderStatus, type ToolCall } from "../types.js";
import { http } from "./shared.js";

const authHeaders = (cfg: ProviderConfig): Record<string, string> => (cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {});

export function toOpenAIMessages(req: ChatRequest) {
  const out: any[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n") });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({ role: "assistant", content: typeof m.content === "string" && m.content ? m.content : null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
    } else if (typeof m.content === "string") out.push({ role: m.role, content: m.content });
    else out.push({ role: m.role, content: m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } })) });
  }
  return out;
}

export class OpenAICompatProvider implements Provider {
  readonly kind = "openai-compat" as const;
  constructor(readonly cfg: ProviderConfig, private fetchImpl: typeof fetch = globalThis.fetch) {}
  get id() { return this.cfg.id; }
  get label() { return this.cfg.label; }
  get local() { return !!this.cfg.local; }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await http(this.cfg, "models", { method: "GET", headers: authHeaders(this.cfg), signal }, this.fetchImpl);
    const j: any = await res.json();
    const rows: any[] = Array.isArray(j) ? j : (j.data ?? j.models ?? []);
    const out = rows.map((r) => {
      const id: string = r.id ?? r.name ?? String(r);
      const arch = r.architecture; // OpenRouter
      const caps = (() => {
        const base = guessCapabilities(id);
        if (arch?.input_modalities?.includes?.("image") || /image/.test(arch?.modality ?? "")) base.push("vision");
        if (Array.isArray(r.supported_parameters)) {
          if (r.supported_parameters.includes("tools") && !base.includes("tools")) base.push("tools");
          if (r.supported_parameters.includes("reasoning") && !base.includes("reasoning")) base.push("reasoning");
        }
        return [...new Set(base)];
      })();
      const price = r.pricing && Number(r.pricing.prompt) >= 0 ? { input: Number(r.pricing.prompt) * 1e6, output: Number(r.pricing.completion) * 1e6 } : undefined;
      return finalize({
        id, name: r.name ?? r.display_name, provider: this.id, local: this.local,
        contextWindow: r.context_length ?? r.context_window ?? r.max_model_len ?? r.inputTokenLimit,
        maxOutput: r.top_provider?.max_completion_tokens ?? r.max_output_tokens,
        capabilities: caps, capabilitySource: arch || r.supported_parameters ? "reported" : "heuristic",
        pricePerMTok: this.cfg.prices?.[id] ?? price,
        loaded: typeof r.status === "string" ? r.status === "loaded" : undefined,
      });
    });
    return mergeManual(this.cfg, out, this.local);
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent> {
    const body: any = { model: req.model, messages: toOpenAIMessages(req), stream: true, stream_options: { include_usage: true } };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens) body[this.cfg.maxTokensParam ?? "max_tokens"] = req.maxTokens;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (req.json) body.response_format = typeof req.json === "object" ? { type: "json_schema", json_schema: { name: "output", schema: req.json, strict: false } } : { type: "json_object" };
    if (req.reasoning && req.reasoning !== "off") body.reasoning_effort = req.reasoning;
    const res = await http(this.cfg, "chat/completions", { method: "POST", json: body, headers: authHeaders(this.cfg), signal: req.signal }, this.fetchImpl);
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish: any = "other";
    let usage: { input: number; output: number } | undefined;
    const flush = function* (): Generator<ChatEvent> {
      for (const [, c] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        let args: Record<string, unknown> = {};
        try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { _raw: c.args }; }
        yield { type: "tool_call", call: { id: c.id, name: c.name, args } as ToolCall };
      }
      pending.clear();
    };
    for await (const ev of sseLines(res, req.signal)) {
      if (ev.data === "[DONE]") break;
      let j: any;
      try { j = JSON.parse(ev.data); } catch { continue; }
      if (j.error) throw new ProviderError(`${this.cfg.label}: ${j.error.message ?? JSON.stringify(j.error)}`, undefined, this.id);
      if (j.usage) usage = { input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 };
      const ch = j.choices?.[0];
      if (!ch) continue;
      const d = ch.delta ?? {};
      if (d.reasoning_content ?? d.reasoning) yield { type: "thinking", text: d.reasoning_content ?? d.reasoning };
      if (d.content) yield { type: "text", text: d.content };
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = pending.get(i) ?? { id: tc.id ?? `call_${i}`, name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        pending.set(i, cur);
      }
      if (ch.finish_reason) finish = ch.finish_reason === "tool_calls" || ch.finish_reason === "function_call" ? "tool_calls" : ch.finish_reason === "length" ? "length" : ch.finish_reason === "stop" ? "stop" : "other";
    }
    yield* flush();
    if (pending.size === 0 && finish === "other") finish = "stop";
    if (usage) yield { type: "usage", ...usage };
    yield { type: "done", finish };
  }

  async embed(model: string, input: string[], signal?: AbortSignal): Promise<number[][]> {
    const res = await http(this.cfg, "embeddings", { method: "POST", json: { model, input }, headers: authHeaders(this.cfg), signal }, this.fetchImpl);
    const j: any = await res.json();
    return (j.data ?? []).sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
  }

  async health(signal?: AbortSignal): Promise<ProviderStatus> {
    const t = Date.now();
    try {
      const m = await this.listModels(signal);
      return { ok: true, latencyMs: Date.now() - t, models: m.length };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t, error: (e as Error).message };
    }
  }
}

export function mergeManual(cfg: ProviderConfig, discovered: ModelInfo[], local: boolean): ModelInfo[] {
  const have = new Set(discovered.map((m) => m.id));
  const manual = ((cfg.manualModels ?? []) as any[])
    .filter((m) => !have.has(m.id))
    .map((m) => finalize({ ...m, provider: cfg.id, local, capabilities: m.capabilities?.length ? m.capabilities : undefined, capabilitySource: "manual" }));
  return [...discovered, ...manual];
}

export type { Message };
