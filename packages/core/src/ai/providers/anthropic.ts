/** Anthropic Messages API adapter (streaming, tools, vision, thinking). */
import { finalize } from "../models.js";
import { sseLines } from "../stream.js";
import { ProviderError, type ChatEvent, type ChatRequest, type ModelInfo, type Provider, type ProviderConfig, type ProviderStatus } from "../types.js";
import { http } from "./shared.js";
import { mergeManual } from "./openai.js";

const VERSION = "2023-06-01";

export function toAnthropicMessages(req: ChatRequest) {
  const out: any[] = [];
  const push = (role: "user" | "assistant", block: any) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of req.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n") });
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    if (typeof m.content === "string") { if (m.content) push(role, { type: "text", text: m.content }); }
    else for (const p of m.content) push(role, p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } });
    for (const c of m.toolCalls ?? []) push("assistant", { type: "tool_use", id: c.id, name: c.name, input: c.args });
  }
  return out;
}

export class AnthropicProvider implements Provider {
  readonly kind = "anthropic" as const;
  constructor(readonly cfg: ProviderConfig, private fetchImpl: typeof fetch = globalThis.fetch) {}
  get id() { return this.cfg.id; }
  get label() { return this.cfg.label; }
  get local() { return false; }
  private headers() {
    return { "x-api-key": this.cfg.apiKey ?? "", "anthropic-version": VERSION, "anthropic-dangerous-direct-browser-access": "true" };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const all: ModelInfo[] = [];
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await http(this.cfg, `models?limit=1000${after ? `&after_id=${after}` : ""}`, { method: "GET", headers: this.headers(), signal }, this.fetchImpl);
      const j: any = await res.json();
      for (const r of j.data ?? []) {
        all.push(finalize({
          id: r.id, name: r.display_name, provider: this.id, local: false,
          capabilities: ["chat", "tools", "vision", "json", "code", "reasoning"], capabilitySource: "heuristic",
          contextWindow: r.max_input_tokens, maxOutput: r.max_tokens, pricePerMTok: this.cfg.prices?.[r.id], modified: r.created_at,
        }));
      }
      if (!j.has_more) break;
      after = j.last_id;
    }
    return mergeManual(this.cfg, all, false);
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent> {
    const body: any = { model: req.model, max_tokens: req.maxTokens ?? 8192, messages: toAnthropicMessages(req), stream: true };
    if (req.system) body.system = req.system;
    if (req.temperature !== undefined && !(req.reasoning && req.reasoning !== "off")) body.temperature = req.temperature;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (req.reasoning && req.reasoning !== "off") {
      const budget = { low: 2048, medium: 6000, high: 16000 }[req.reasoning];
      body.thinking = { type: "enabled", budget_tokens: budget };
      body.max_tokens = Math.max(body.max_tokens, budget + 2048);
    }
    if (req.json && typeof req.json !== "object") body.system = `${body.system ?? ""}\nRespond with a single valid JSON value and nothing else.`.trim();
    const res = await http(this.cfg, "messages", { method: "POST", json: body, headers: this.headers(), signal: req.signal }, this.fetchImpl);
    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
    let inTok = 0, outTok = 0;
    let finish: any = "other";
    for await (const ev of sseLines(res, req.signal)) {
      let j: any;
      try { j = JSON.parse(ev.data); } catch { continue; }
      switch (j.type) {
        case "message_start": inTok = j.message?.usage?.input_tokens ?? 0; outTok = j.message?.usage?.output_tokens ?? 0; break;
        case "content_block_start": blocks.set(j.index, { type: j.content_block.type, id: j.content_block.id, name: j.content_block.name, json: "" }); break;
        case "content_block_delta": {
          const d = j.delta;
          if (d.type === "text_delta") yield { type: "text", text: d.text };
          else if (d.type === "thinking_delta") yield { type: "thinking", text: d.thinking };
          else if (d.type === "input_json_delta") { const b = blocks.get(j.index); if (b) b.json += d.partial_json; }
          break;
        }
        case "content_block_stop": {
          const b = blocks.get(j.index);
          if (b?.type === "tool_use") {
            let args: Record<string, unknown> = {};
            try { args = b.json ? JSON.parse(b.json) : {}; } catch { args = { _raw: b.json }; }
            yield { type: "tool_call", call: { id: b.id!, name: b.name!, args } };
          }
          break;
        }
        case "message_delta":
          if (j.usage?.output_tokens !== undefined) outTok = j.usage.output_tokens;
          if (j.delta?.stop_reason) finish = j.delta.stop_reason === "tool_use" ? "tool_calls" : j.delta.stop_reason === "max_tokens" ? "length" : j.delta.stop_reason === "end_turn" || j.delta.stop_reason === "stop_sequence" ? "stop" : "other";
          break;
        case "error": throw new ProviderError(`${this.cfg.label}: ${j.error?.message ?? "stream error"}`, undefined, this.id, j.error?.type === "overloaded_error");
      }
    }
    yield { type: "usage", input: inTok, output: outTok };
    yield { type: "done", finish };
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
