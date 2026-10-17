/** Provider-independent AI types. No model list is hardcoded anywhere. */

export type Capability = "chat" | "tools" | "vision" | "embeddings" | "reasoning" | "json" | "code";

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string; // provider config id
  contextWindow?: number;
  maxOutput?: number;
  paramsB?: number; // billions of parameters, when known
  quantization?: string;
  sizeBytes?: number;
  memoryGB?: number; // approximate RAM/VRAM needed (local models)
  capabilities: Capability[];
  /** Where capabilities came from: reported by the runtime, or guessed from the model id. */
  capabilitySource: "reported" | "heuristic" | "manual";
  local: boolean;
  pricePerMTok?: { input: number; output: number };
  family?: string;
  loaded?: boolean;
  modified?: string;
}

export type Part = { type: "text"; text: string } | { type: "image"; mediaType: string; data: string /* base64 */ };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Part[];
  toolCalls?: ToolCall[]; // assistant → tools it wants run
  toolCallId?: string; // tool result → which call
  name?: string; // tool name for tool results
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDef[];
  json?: boolean | Record<string, unknown>; // true = any JSON, object = JSON schema
  reasoning?: "off" | "low" | "medium" | "high";
  signal?: AbortSignal;
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; input: number; output: number }
  | { type: "done"; finish: "stop" | "length" | "tool_calls" | "error" | "other" };

export interface ChatResult {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
  finish: string;
  ms: number;
}

export interface ProviderStatus {
  ok: boolean;
  latencyMs: number;
  version?: string;
  models?: number;
  error?: string;
  detail?: string;
}

export interface Provider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly label: string;
  readonly local: boolean;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(req: ChatRequest): AsyncIterable<ChatEvent>;
  embed?(model: string, input: string[], signal?: AbortSignal): Promise<number[][]>;
  health(signal?: AbortSignal): Promise<ProviderStatus>;
}

export type ProviderKind = "openai-compat" | "anthropic" | "ollama";

export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  preset?: string;
  baseUrl: string;
  apiKey?: string;
  local?: boolean;
  headers?: Record<string, string>;
  /** Models registered by hand (always merged with discovered ones). */
  manualModels?: Partial<ModelInfo> & { id: string }[] | { id: string; contextWindow?: number; capabilities?: Capability[] }[];
  /** Price table for cost limits, keyed by model id. USD per million tokens. */
  prices?: Record<string, { input: number; output: number }>;
  maxCostUsd?: number;
  defaultModel?: string;
  fallbackProviderId?: string;
  contextLimit?: number;
  temperature?: number;
  reasoning?: ChatRequest["reasoning"];
  /** Use max_completion_tokens instead of max_tokens (newer OpenAI models). */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  enabled?: boolean;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly provider?: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatResult> {
  const started = Date.now();
  const r: ChatResult = { text: "", thinking: "", toolCalls: [], usage: { input: 0, output: 0 }, finish: "other", ms: 0 };
  for await (const e of stream) {
    if (e.type === "text") r.text += e.text;
    else if (e.type === "thinking") r.thinking += e.text;
    else if (e.type === "tool_call") r.toolCalls.push(e.call);
    else if (e.type === "usage") {
      r.usage.input += e.input;
      r.usage.output += e.output;
    } else if (e.type === "done") r.finish = e.finish;
  }
  r.ms = Date.now() - started;
  return r;
}
