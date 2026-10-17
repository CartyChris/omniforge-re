import { AnthropicProvider } from "./providers/anthropic.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAICompatProvider } from "./providers/openai.js";
import { ProviderError, type ChatEvent, type ChatRequest, type ModelInfo, type Provider, type ProviderConfig, type ProviderKind, type ProviderStatus } from "./types.js";
import { uid } from "../util/index.js";

export interface Preset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  local: boolean;
  needsKey: boolean;
  note?: string;
  maxTokensParam?: ProviderConfig["maxTokensParam"];
  docs?: string;
}

/** Endpoint presets only. Models are always discovered from the endpoint, never listed here. */
export const PRESETS: Preset[] = [
  { id: "anthropic", label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", local: false, needsKey: true, docs: "https://docs.anthropic.com" },
  { id: "openai", label: "OpenAI", kind: "openai-compat", baseUrl: "https://api.openai.com/v1", local: false, needsKey: true, maxTokensParam: "max_completion_tokens" },
  { id: "gemini", label: "Google Gemini", kind: "openai-compat", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", local: false, needsKey: true, note: "Uses Google's OpenAI-compatible endpoint" },
  { id: "xai", label: "xAI (Grok)", kind: "openai-compat", baseUrl: "https://api.x.ai/v1", local: false, needsKey: true },
  { id: "moonshot", label: "Moonshot (Kimi)", kind: "openai-compat", baseUrl: "https://api.moonshot.ai/v1", local: false, needsKey: true },
  { id: "openrouter", label: "OpenRouter", kind: "openai-compat", baseUrl: "https://openrouter.ai/api/v1", local: false, needsKey: true, note: "Hundreds of models; reports pricing and context size" },
  { id: "ollama", label: "Ollama", kind: "ollama", baseUrl: "http://localhost:11434", local: true, needsKey: false },
  { id: "lmstudio", label: "LM Studio", kind: "openai-compat", baseUrl: "http://localhost:1234/v1", local: true, needsKey: false },
  { id: "llamacpp", label: "llama.cpp server", kind: "openai-compat", baseUrl: "http://localhost:8080/v1", local: true, needsKey: false },
  { id: "mlx", label: "MLX (mlx_lm.server)", kind: "openai-compat", baseUrl: "http://localhost:8080/v1", local: true, needsKey: false, note: "Same default port as llama.cpp; run one at a time or change the port" },
  { id: "unsloth", label: "Unsloth Studio", kind: "openai-compat", baseUrl: "http://localhost:8888/v1", local: true, needsKey: true, note: "Create an sk-unsloth-… key in Studio → Settings → API. The API port can differ from the UI port; probing tries 8888 and 8000." },
  { id: "vllm", label: "vLLM", kind: "openai-compat", baseUrl: "http://localhost:8000/v1", local: true, needsKey: false },
  { id: "custom", label: "Custom OpenAI-compatible", kind: "openai-compat", baseUrl: "https://", local: false, needsKey: false },
];

export function configFromPreset(presetId: string, o: Partial<ProviderConfig> = {}): ProviderConfig {
  const p = PRESETS.find((x) => x.id === presetId) ?? PRESETS[PRESETS.length - 1]!;
  return { id: o.id ?? `${p.id}-${uid("p").slice(-4)}`, label: p.label, kind: p.kind, preset: p.id, baseUrl: p.baseUrl, local: p.local, maxTokensParam: p.maxTokensParam, enabled: true, ...o };
}

export function createProvider(cfg: ProviderConfig, fetchImpl: typeof fetch = globalThis.fetch): Provider {
  switch (cfg.kind) {
    case "anthropic": return new AnthropicProvider(cfg, fetchImpl);
    case "ollama": return new OllamaProvider(cfg, fetchImpl);
    default: return new OpenAICompatProvider(cfg, fetchImpl);
  }
}

/* ---------------- usage + cost ---------------- */

export class UsageMeter {
  input = 0;
  output = 0;
  costUsd = 0;
  unpriced = 0; // calls where the model had no known price
  add(input: number, output: number, price?: { input: number; output: number }) {
    this.input += input;
    this.output += output;
    if (price) this.costUsd += (input * price.input + output * price.output) / 1e6;
    else this.unpriced += input + output;
  }
}

/** Wraps a provider with: cost ceiling, usage metering and an optional fallback provider. */
export function governed(primary: Provider, o: { cfg: ProviderConfig; meter: UsageMeter; fallback?: Provider; prices?: Record<string, { input: number; output: number }> }): Provider {
  const priceOf = (model: string) => o.cfg.prices?.[model] ?? o.prices?.[model];
  return {
    id: primary.id, kind: primary.kind, label: primary.label, local: primary.local,
    listModels: (s) => primary.listModels(s),
    health: (s) => primary.health(s),
    embed: primary.embed?.bind(primary),
    async *chat(req: ChatRequest): AsyncGenerator<ChatEvent> {
      if (o.cfg.maxCostUsd !== undefined && o.meter.costUsd >= o.cfg.maxCostUsd) {
        throw new ProviderError(`Cost limit of $${o.cfg.maxCostUsd.toFixed(2)} reached for ${o.cfg.label} ($${o.meter.costUsd.toFixed(4)} spent). Raise the limit in Settings to continue.`, undefined, o.cfg.id);
      }
      let emitted = false;
      try {
        for await (const e of primary.chat(req)) {
          if (e.type === "usage") o.meter.add(e.input, e.output, priceOf(req.model));
          if (e.type !== "usage" && e.type !== "done") emitted = true;
          yield e;
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        // Only fall back when nothing has been shown to the user yet.
        if (o.fallback && !emitted) {
          yield { type: "thinking", text: `[${primary.label} failed (${(err as Error).message}); falling back to ${o.fallback.label}]\n` };
          const fbModel = req.model;
          yield* o.fallback.chat({ ...req, model: fbModel });
          return;
        }
        throw err;
      }
    },
  };
}

/* ---------------- discovery ---------------- */

export interface LocalCandidate { presetId: string; baseUrl: string; kind: ProviderKind }
export const LOCAL_CANDIDATES: LocalCandidate[] = [
  { presetId: "ollama", baseUrl: "http://localhost:11434", kind: "ollama" },
  { presetId: "lmstudio", baseUrl: "http://localhost:1234/v1", kind: "openai-compat" },
  { presetId: "llamacpp", baseUrl: "http://localhost:8080/v1", kind: "openai-compat" },
  { presetId: "unsloth", baseUrl: "http://localhost:8888/v1", kind: "openai-compat" },
  { presetId: "unsloth", baseUrl: "http://localhost:8000/v1", kind: "openai-compat" },
  { presetId: "vllm", baseUrl: "http://localhost:8000/v1", kind: "openai-compat" },
];

export interface DiscoveredService {
  presetId: string;
  baseUrl: string;
  status: "reachable" | "needs-auth" | "unreachable";
  detail: string;
  models?: number;
  version?: string;
}

/** Probe well-known local ports. Reports real failures; never claims a service is present without a response. */
export async function discoverLocalServices(fetchImpl: typeof fetch = globalThis.fetch, signal?: AbortSignal, candidates = LOCAL_CANDIDATES): Promise<DiscoveredService[]> {
  return Promise.all(
    candidates.map(async (c): Promise<DiscoveredService> => {
      const cfg = configFromPreset(c.presetId, { baseUrl: c.baseUrl, id: `probe-${c.presetId}` });
      const prov = createProvider(cfg, fetchImpl);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
      try {
        const h: ProviderStatus = await prov.health(ctrl.signal);
        if (h.ok) return { presetId: c.presetId, baseUrl: c.baseUrl, status: "reachable", detail: `${h.models ?? 0} model(s)`, models: h.models, version: h.version };
        if (/HTTP 40[13]/.test(h.error ?? "")) return { presetId: c.presetId, baseUrl: c.baseUrl, status: "needs-auth", detail: "Responded but requires an API key" };
        return { presetId: c.presetId, baseUrl: c.baseUrl, status: "unreachable", detail: h.error ?? "no response" };
      } finally {
        clearTimeout(t);
      }
    }),
  );
}

export async function allModels(providers: Provider[], signal?: AbortSignal): Promise<{ models: ModelInfo[]; errors: { provider: string; error: string }[] }> {
  const models: ModelInfo[] = [];
  const errors: { provider: string; error: string }[] = [];
  await Promise.all(providers.map(async (p) => { try { models.push(...(await p.listModels(signal))); } catch (e) { errors.push({ provider: p.label, error: (e as Error).message }); } }));
  return { models, errors };
}
