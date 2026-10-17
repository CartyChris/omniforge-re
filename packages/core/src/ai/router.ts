/**
 * Task → model routing. Configurable by task, cost, latency, privacy and
 * capability; falls back to whatever is actually available. Explanations are
 * returned so the UI can show *why* a model was chosen.
 */
import { tierOf, type Tier } from "./models.js";
import type { Capability, ModelInfo } from "./types.js";

export type TaskKind = "classify" | "extract" | "summarize" | "architecture" | "code" | "review" | "vision" | "embed" | "research" | "test";

export const TASK_PROFILES: Record<TaskKind, { label: string; prefer: Tier[]; needs: Capability[]; hint: string }> = {
  classify: { label: "Classification & metadata", prefer: ["small", "medium"], needs: ["chat"], hint: "Fast, cheap, high volume" },
  extract: { label: "Structured extraction", prefer: ["small", "medium"], needs: ["chat", "json"], hint: "JSON-capable small/medium model" },
  summarize: { label: "Summaries & architecture notes", prefer: ["medium", "large", "frontier"], needs: ["chat"], hint: "Mid-size model" },
  architecture: { label: "Architecture & planning", prefer: ["frontier", "large"], needs: ["chat", "reasoning"], hint: "Strongest reasoning available" },
  code: { label: "Implementation & coding", prefer: ["frontier", "large", "medium"], needs: ["chat", "tools", "code"], hint: "Tool-using coder" },
  review: { label: "Code review & verification", prefer: ["frontier", "large"], needs: ["chat", "code"], hint: "Independent second opinion (different model than the author when possible)" },
  vision: { label: "Screenshots & UI analysis", prefer: ["frontier", "large", "medium", "vision"], needs: ["vision"], hint: "Vision-capable model" },
  embed: { label: "Embeddings / retrieval", prefer: ["embedding"], needs: ["embeddings"], hint: "Embedding model" },
  research: { label: "Research", prefer: ["frontier", "large"], needs: ["chat"], hint: "Long-context general model" },
  test: { label: "Test authoring", prefer: ["large", "frontier", "medium"], needs: ["chat", "code"], hint: "Coder" },
};

export interface RoutingPrefs {
  privacy: "any" | "local-only";
  optimise: "quality" | "cost" | "latency";
  /** Explicit user assignment wins: taskKind → "providerId::modelId". */
  assignments?: Partial<Record<TaskKind, string>>;
  /** Observed pass-rates per model id (0..1) from past verified runs, used as a tie-breaker. */
  observed?: Record<string, number>;
  avoid?: string[]; // model keys to skip (e.g. the author of the code under review)
}

export const modelKey = (m: Pick<ModelInfo, "provider" | "id">) => `${m.provider}::${m.id}`;

export interface Choice { model: ModelInfo; score: number; reasons: string[] }

export function chooseModel(task: TaskKind, models: ModelInfo[], prefs: RoutingPrefs): Choice | null {
  const profile = TASK_PROFILES[task];
  const assigned = prefs.assignments?.[task];
  if (assigned) {
    const m = models.find((x) => modelKey(x) === assigned);
    if (m) return { model: m, score: 1e6, reasons: ["Assigned explicitly in Settings"] };
  }
  const pool = models.filter((m) => (prefs.privacy === "local-only" ? m.local : true) && !(prefs.avoid ?? []).includes(modelKey(m)));
  const scored: Choice[] = [];
  for (const m of pool) {
    const missing = profile.needs.filter((c) => !m.capabilities.includes(c));
    // vision/embeddings are hard requirements; tools/code/reasoning are soft
    if (profile.needs.some((c) => (c === "vision" || c === "embeddings") && !m.capabilities.includes(c))) continue;
    if (task !== "embed" && !m.capabilities.includes("chat")) continue;
    const reasons: string[] = [];
    let score = 0;
    const tier = tierOf(m);
    const rank = profile.prefer.indexOf(tier);
    const tierWeight = prefs.optimise === "cost" ? 8 : 20; // cost mode: cheapest model that meets the requirements
    if (rank >= 0) { score += (profile.prefer.length - rank) * tierWeight; reasons.push(`${tier} tier suits ${profile.label.toLowerCase()}`); }
    score -= missing.length * 15;
    if (missing.length) reasons.push(`missing ${missing.join(", ")}`);
    if (prefs.optimise === "cost") {
      if (m.local) { score += 30; reasons.push("local = free"); }
      else if (m.pricePerMTok) score += Math.max(0, 15 - Math.log10(1 + m.pricePerMTok.input + m.pricePerMTok.output) * 6);
      if (m.paramsB !== undefined) score -= Math.min(15, m.paramsB / 8);
    } else if (prefs.optimise === "latency") {
      if (m.paramsB !== undefined) score += Math.max(0, 20 - m.paramsB / 3);
      if (m.loaded) { score += 10; reasons.push("already loaded in memory"); }
    } else {
      if (m.paramsB !== undefined) score += Math.min(20, Math.log2(1 + m.paramsB) * 3);
      else if (!m.local) score += 12;
      if ((m.contextWindow ?? 0) >= 100_000) score += 4;
    }
    if (m.capabilitySource === "heuristic") score -= 2;
    const obs = prefs.observed?.[m.id];
    if (obs !== undefined) { score += (obs - 0.5) * 20; reasons.push(`observed pass-rate ${Math.round(obs * 100)}%`); }
    scored.push({ model: m, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] ?? null;
}

/** Recommend an installed model per task for the Local Models dashboard. */
export function recommendForAll(models: ModelInfo[], prefs: RoutingPrefs): Record<TaskKind, Choice | null> {
  return Object.fromEntries((Object.keys(TASK_PROFILES) as TaskKind[]).map((t) => [t, chooseModel(t, models, prefs)])) as Record<TaskKind, Choice | null>;
}

/** Will it fit? Compares estimated need with available memory. */
export function fitsMemory(m: ModelInfo, availableGB: number): "fits" | "tight" | "too-large" | "unknown" {
  if (!m.memoryGB) return "unknown";
  if (m.memoryGB <= availableGB * 0.6) return "fits";
  if (m.memoryGB <= availableGB * 0.9) return "tight";
  return "too-large";
}
