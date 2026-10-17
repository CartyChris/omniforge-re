import type { Capability, ModelInfo } from "./types.js";

/** Parse "7b", "70B", "8x7b", "1.5b", "270m" from a model id/tag. */
export function parseParamsB(s: string): number | undefined {
  const t = s.toLowerCase();
  const moe = t.match(/(\d+)x(\d+(?:\.\d+)?)b/);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const b = t.match(/(?<![a-z0-9])(\d+(?:\.\d+)?)b(?![a-z])/);
  if (b) return Number(b[1]);
  const m = t.match(/(?<![a-z0-9])(\d+(?:\.\d+)?)m(?![a-z])/);
  if (m) return Number(m[1]) / 1000;
  return undefined;
}

/** Bytes per parameter for common quantisations (approximate). */
export function bytesPerParam(q?: string): number {
  const s = (q ?? "").toLowerCase();
  if (/f32/.test(s)) return 4;
  if (/f16|bf16/.test(s)) return 2;
  if (/q8/.test(s)) return 1.07;
  if (/q6/.test(s)) return 0.82;
  if (/q5/.test(s)) return 0.69;
  if (/q4|nf4|int4|awq|gptq/.test(s)) return 0.57;
  if (/q3/.test(s)) return 0.44;
  if (/q2/.test(s)) return 0.34;
  return 0.6;
}

/** RAM estimate (GB): weights + ~15% runtime overhead + KV cache for a 4k context. */
export function estimateMemoryGB(paramsB?: number, quant?: string, sizeBytes?: number): number | undefined {
  if (sizeBytes) return Math.round(((sizeBytes * 1.15) / 1e9 + 0.5) * 10) / 10;
  if (!paramsB) return undefined;
  return Math.round((paramsB * bytesPerParam(quant) * 1.15 + 0.5) * 10) / 10;
}

const VISION_RE = /vision|vl\b|-vl|llava|bakllava|moondream|minicpm-v|gemini|gpt-4o|gpt-4\.1|gpt-5|o4|pixtral|qwen.*vl|gemma-?3|llama-?3\.2-vision|claude|grok.*vision|kimi.*(?:vl|k2\.5)/i;
const EMBED_RE = /embed|bge-|gte-|e5-|minilm|nomic|mxbai|arctic-embed|snowflake/i;
const REASON_RE = /\br1\b|reason|thinking|o1|o3|o4|qwq|deepseek-r|gpt-5|claude|gemini-(?:2\.5|3)|kimi-k2|magistral|grok-4/i;
const CODE_RE = /code|coder|codex|starcoder|devstral|granite-code|deepseek-coder|qwen.*coder|claude|gpt-5|gpt-4\.1/i;
const NOTOOLS_RE = /embed|\bbase\b|-base\b|instruct-v0\.1|llava|bakllava|moondream/i;

/** Capabilities guessed from a model id. Always labelled `heuristic`; runtimes that report capabilities override this. */
export function guessCapabilities(id: string): Capability[] {
  if (EMBED_RE.test(id)) return ["embeddings"];
  const caps: Capability[] = ["chat", "json"];
  if (!NOTOOLS_RE.test(id)) caps.push("tools");
  if (VISION_RE.test(id)) caps.push("vision");
  if (REASON_RE.test(id)) caps.push("reasoning");
  if (CODE_RE.test(id)) caps.push("code");
  return caps;
}

export type Tier = "small" | "medium" | "large" | "frontier" | "embedding" | "vision";

/** Size tier used by the router (cloud models without a size count as frontier). */
export function tierOf(m: ModelInfo): Tier {
  if (m.capabilities.includes("embeddings") && !m.capabilities.includes("chat")) return "embedding";
  if (m.paramsB === undefined) return m.local ? "medium" : "frontier";
  if (m.paramsB <= 9) return "small";
  if (m.paramsB <= 35) return "medium";
  return "large";
}

export function finalize(m: Partial<ModelInfo> & { id: string; provider: string; local: boolean }): ModelInfo {
  const paramsB = m.paramsB ?? parseParamsB(m.id);
  const caps = m.capabilities?.length ? m.capabilities : guessCapabilities(m.id);
  return {
    ...m,
    paramsB,
    capabilities: caps,
    capabilitySource: m.capabilitySource ?? (m.capabilities?.length ? "reported" : "heuristic"),
    memoryGB: m.local ? (m.memoryGB ?? estimateMemoryGB(paramsB, m.quantization, m.sizeBytes)) : undefined,
  };
}
