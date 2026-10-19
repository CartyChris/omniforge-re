/** Builds live providers from saved configs + vaulted keys; discovers models; bridges CLIs. */
import { allModels, buildEditPrompt, collect, parseEditReply, type EditProposal, type EditRejection, type EditRequest, configFromPreset, createProvider, executeGraph, governed, memoryFS, UsageMeter, type AgentTask, type ChatEvent, type ChatRequest, type ModelInfo, type Provider, type ProviderConfig, type ProviderStatus, type RunContext, type WorkspaceFS, type CommandRunner, chooseModel, type TaskKind } from "@omniforge/core";
import { enabledSkills } from "./skills";
import { mcpAgentTools } from "./mcp";
import { useApp } from "./store";
import { vault, VaultLocked } from "./vault";
import { smartFetch } from "./net";
import { readSSE } from "./bridge";
import { requestApproval } from "./approvals";
import type { LocalWorkspace } from "./localfs";

export const meters = new Map<string, UsageMeter>();
export const keyName = (id: string) => `provider:${id}`;
const fetcher = () => smartFetch(() => useApp.getState().bridge);

/** CLIs installed on the user's Mac, exposed as ordinary providers (runs through the bridge). */
export class BridgeCliProvider implements Provider {
  readonly kind = "openai-compat" as const; readonly local = false;
  constructor(private cliId: string, private name: string, private root?: string) {}
  get id() { return `cli:${this.cliId}`; } get label() { return this.name; }
  async listModels(): Promise<ModelInfo[]> { return [{ id: this.cliId, name: `${this.name} (agentic CLI)`, provider: this.id, capabilities: ["chat", "code", "reasoning"], capabilitySource: "reported", local: false }]; }
  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent> {
    const b = useApp.getState().bridge; if (!b) throw new Error("Desktop companion is not connected.");
    const text = (m: ChatRequest["messages"][number]) => (typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p: any) => p.text).join("\n"));
    const prompt = [req.system ? `[System]\n${req.system}\n` : "", ...req.messages.map((m) => `[${m.role}]\n${text(m)}`)].filter(Boolean).join("\n\n");
    const res = await b.raw("POST", "/bridge/cli/run", { id: this.cliId, prompt, root: this.root }, req.signal);
    const q: ChatEvent[] = []; let wake: (() => void) | null = null; let done = false; let err: Error | null = null;
    readSSE(res, (ev, d) => { if (ev === "end") done = true; else if (ev === "error") err = new Error(d.message); else q.push(d as ChatEvent); wake?.(); }, req.signal).catch((e) => { err = e; }).finally(() => { done = true; wake?.(); });
    while (!done || q.length) { if (q.length) { yield q.shift()!; continue; } await new Promise<void>((r) => (wake = r)); }
    if (err) throw err;
  }
  async health(): Promise<ProviderStatus> { const t = Date.now(); try { const l = await useApp.getState().bridge!.get<any[]>("/bridge/cli"); const me = l.find((c) => c.id === this.cliId); return { ok: me?.status === "ready", latencyMs: Date.now() - t, version: me?.version, error: me?.status === "ready" ? undefined : `${this.name}: ${me?.status ?? "unavailable"}` }; } catch (e) { return { ok: false, latencyMs: Date.now() - t, error: (e as Error).message }; } }
}

export async function loadProviders(): Promise<{ providers: Provider[]; skipped: { provider: string; reason: string }[] }> {
  const { providers: cfgs, settings, bridgeInfo } = useApp.getState();
  const out: Provider[] = []; const skipped: { provider: string; reason: string }[] = [];
  const byId = new Map<string, Provider>();
  for (const c of cfgs.filter((x) => x.enabled !== false)) {
    if (settings.localOnly && !c.local) { skipped.push({ provider: c.label, reason: "Local-only mode is on" }); continue; }
    let key: string | undefined;
    try { key = await vault.get(keyName(c.id)); } catch (e) { skipped.push({ provider: c.label, reason: e instanceof VaultLocked ? "Vault is locked" : (e as Error).message }); continue; }
    const cfg: ProviderConfig = { ...c, apiKey: key };
    const meter = meters.get(c.id) ?? new UsageMeter(); meters.set(c.id, meter);
    const base = createProvider(cfg, fetcher());
    byId.set(c.id, base);
    out.push({ cfg, base, meter } as unknown as Provider);
  }
  const final: Provider[] = out.map((o: any) => {
    const fb = o.cfg.fallbackProviderId ? byId.get(o.cfg.fallbackProviderId) : undefined;
    return governed(o.base, { cfg: o.cfg, meter: o.meter, fallback: fb });
  });
  if (bridgeInfo && useApp.getState().bridge) for (const c of bridgeInfo.clis.filter((x: any) => x.status === "ready")) final.push(new BridgeCliProvider(c.id, c.name));
  return { providers: final, skipped };
}

export async function refreshModels() {
  useApp.setState({ modelsLoading: true });
  const { providers, skipped } = await loadProviders();
  const r = await allModels(providers);
  useApp.getState().setModels(r.models, [...skipped.map((s) => ({ provider: s.provider, error: s.reason })), ...r.errors]);
  return r;
}

export async function testProvider(cfg: ProviderConfig, key?: string): Promise<ProviderStatus & { models?: number }> {
  const p = createProvider({ ...cfg, apiKey: key }, fetcher());
  return p.health();
}

export function newProviderConfig(presetId: string, o: Partial<ProviderConfig> = {}): ProviderConfig { return configFromPreset(presetId, o); }

/** Pick the model for a task using the user's routing prefs. */
export function pickModel(task: TaskKind): { model: ModelInfo; reasons: string[] } | null {
  const { models, settings } = useApp.getState();
  const c = chooseModel(task, models, { privacy: settings.localOnly ? "local-only" : "any", optimise: settings.optimise, assignments: settings.assignments });
  return c ? { model: c.model, reasons: c.reasons } : null;
}

/** Run a one-shot prompt against whatever model suits the task. */
export async function ask(task: TaskKind, prompt: string, o: { system?: string; json?: boolean; signal?: AbortSignal; onText?: (t: string) => void; maxTokens?: number } = {}) {
  const pick = pickModel(task); if (!pick) throw new Error("No model is available. Connect a provider in AI Studio (or install a local model).");
  const { providers } = await loadProviders();
  const prov = providers.find((p) => p.id === pick.model.provider); if (!prov) throw new Error(`Provider ${pick.model.provider} is not available.`);
  let text = "";
  const r = await collect((async function* () { for await (const e of prov.chat({ model: pick.model.id, system: o.system, messages: [{ role: "user", content: prompt }], signal: o.signal, json: o.json, maxTokens: o.maxTokens ?? 4096 })) { if (e.type === "text") o.onText?.((text += e.text)); yield e; } })());
  return { text: r.text, model: pick.model, usage: r.usage };
}

/**
 * Ask the code model for a replacement of ONE file. Returns a proposal (never writes anything) or the reason it cannot be trusted.
 * The output budget scales with the file so a long file is not silently cut off — and a cut-off reply is rejected by parseEditReply.
 */
export async function proposeEdit(req: EditRequest, o: { signal?: AbortSignal; onText?: (t: string) => void } = {}): Promise<(EditProposal & { model: ModelInfo }) | EditRejection> {
  const { system, prompt } = buildEditPrompt(req);
  const pick = pickModel("code"); if (!pick) throw new Error("No model is available. Connect a provider in AI Studio (or start a local model).");
  const want = Math.ceil(req.content.length / 2.8) + 1500;
  const r = await ask("code", prompt, { system, signal: o.signal, onText: o.onText, maxTokens: Math.max(4096, Math.min(want, pick.model.maxOutput ?? 16_000, 32_000)) });
  const parsed = parseEditReply(r.text, req.content);
  return parsed.ok ? { ...parsed, model: r.model } : parsed;
}

/* ---------------- workspace FS + runner for agents ---------------- */

export function projectFS(): WorkspaceFS & { flush(): void } {
  const st = useApp.getState();
  const files = { ...(st.project?.workspace.files ?? {}) };
  let t: ReturnType<typeof setTimeout> | undefined;
  const sync = () => { clearTimeout(t); t = setTimeout(() => useApp.getState().mutate((p) => ({ ...p, workspace: { ...p.workspace, files: { ...files } } })), 250); };
  return {
    read: (p) => files[p], write: (p, c) => { files[p] = c; sync(); }, remove: (p) => { delete files[p]; sync(); }, list: () => Object.keys(files).sort(),
    flush() { clearTimeout(t); useApp.getState().mutate((p) => ({ ...p, workspace: { ...p.workspace, files: { ...files } } })); },
  };
}

/** Commands run only on the user's computer, in an approved folder, after explicit approval of EACH command. */
export function bridgeRunner(rootId: string): CommandRunner | undefined {
  const b = useApp.getState().bridge; if (!b) return undefined;
  return {
    async run(cmd, o) {
      const meta = await b.post<{ id: string }>("/bridge/jobs", { root: rootId, shell: true, command: cmd, timeoutMs: o.timeoutMs });
      let out = ""; let code = 1;
      const res = await b.raw("GET", `/bridge/jobs/${meta.id}/stream`, undefined, o.signal);
      await readSSE(res, (ev, d) => { if (ev === "line") out += d.text + "\n"; else if (ev === "end") code = d.code ?? (d.state === "done" ? 0 : 1); });
      return { code, output: out };
    },
  };
}

export async function runPlan(tasks: AgentTask[], o: { onUpdate: (t: AgentTask[]) => void; signal?: AbortSignal; rootId?: string; local?: LocalWorkspace; brief?: string; concurrency?: number; skip?: Set<string> }) {
  const { providers } = await loadProviders();
  const fs = o.local?.fs ?? projectFS();
  const ctx: RunContext = {
    tools: { fs, writes: [], deletes: [], extra: await mcpAgentTools(), runner: o.local?.runner ?? (o.rootId ? bridgeRunner(o.rootId) : undefined), approve: (cmd) => requestApproval({ kind: "command", title: "Run this command?", detail: "An AI agent wants to run a command in your project folder.", command: cmd, danger: /rm\s|sudo|curl[^|]*\|\s*(ba)?sh|chmod|mkfs|dd\s/.test(cmd) }) },
    providerFor: (m) => providers.find((p) => p.id === m.provider),
    models: useApp.getState().models, prefs: { privacy: useApp.getState().settings.localOnly ? "local-only" : "any", optimise: useApp.getState().settings.optimise, assignments: useApp.getState().settings.assignments },
    projectBrief: o.brief, signal: o.signal, skills: await enabledSkills(),
  };
  const res = await executeGraph(tasks, ctx, { onUpdate: o.onUpdate, signal: o.signal, concurrency: o.concurrency ?? 3, skip: o.skip });
  await (fs as { flush(): void | Promise<void> }).flush();
  return res;
}
export { memoryFS };
