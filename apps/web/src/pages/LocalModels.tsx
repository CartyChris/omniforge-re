import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Cpu, ExternalLink, Info, MemoryStick, Plus, RefreshCw, Zap } from "lucide-react";
import { LOCAL_CANDIDATES, TASK_PROFILES, discoverLocalServices, fitsMemory, modelKey, recommendForAll, type DiscoveredService, type TaskKind } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { newProviderConfig, refreshModels } from "@/lib/ai";
import { smartFetch } from "@/lib/net";
import { cn, fmtBytes } from "@/lib/utils";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, SectionTitle, StatusDot } from "@/components/ui/primitives";
import { CopyButton } from "@/components/ui/primitives";

const INFO: Record<string, { name: string; blurb: string; install: string; link: string }> = {
  ollama: { name: "Ollama", blurb: "Easiest way to run open models on a Mac.", install: "brew install ollama && ollama serve", link: "https://ollama.com/download" },
  lmstudio: { name: "LM Studio", blurb: "GUI model manager with a local server.", install: "Open LM Studio → Developer → Start Server", link: "https://lmstudio.ai" },
  llamacpp: { name: "llama.cpp", blurb: "Fast GGUF inference (Metal on Apple Silicon).", install: "brew install llama.cpp && llama-server -m model.gguf --port 8080", link: "https://github.com/ggml-org/llama.cpp" },
  unsloth: { name: "Unsloth", blurb: "Run and fine-tune with Unsloth's local server.", install: "See Unsloth's docs for starting the OpenAI-compatible API", link: "https://unsloth.ai" },
  vllm: { name: "vLLM", blurb: "High-throughput server (Linux/GPU).", install: "vllm serve <model> --port 8000", link: "https://docs.vllm.ai" },
  mlx: { name: "MLX", blurb: "Apple's array framework; mlx-lm ships a server.", install: "pip install mlx-lm && mlx_lm.server --model <model> --port 8081", link: "https://github.com/ml-explore/mlx-lm" },
};
const TONE = { fits: "ok", tight: "warn", "too-large": "bad", unknown: "neutral" } as const;

export default function LocalModels() {
  const { models, providers, setProviders, bridge, bridgeInfo, bridgeState, settings, patchSettings, modelsLoading } = useApp();
  const [scan, setScan] = useState<DiscoveredService[] | null>(null); const [scanning, setScanning] = useState(false);
  // With the desktop app, the companion already probed the ports (server-side, no browser permission prompts). In a plain browser the
  // scan only runs when asked: probing localhost can trigger the browser's "local network access" prompt.
  const run = useCallback(async () => {
    setScanning(true);
    try { setScan(await discoverLocalServices(smartFetch(() => useApp.getState().bridge))); } finally { setScanning(false); }
  }, []);
  useEffect(() => { if (bridgeState === "connected") void run(); }, [run, bridgeState]);
  const services = scan ?? [];
  const mem = bridgeInfo?.system.memTotalGB;
  const local = useMemo(() => models.filter((m) => m.local), [models]);
  const recs = useMemo(() => recommendForAll(local, { privacy: "local-only", optimise: settings.optimise, assignments: {} }), [local, settings.optimise]);
  const add = async (s: DiscoveredService) => {
    if (providers.some((p) => p.baseUrl === s.baseUrl)) return toast.info("Already added");
    setProviders([...providers, newProviderConfig(s.presetId, { baseUrl: s.baseUrl })]); await refreshModels(); toast.success(`${INFO[s.presetId]?.name ?? s.presetId} added`);
  };
  const reachable = services.filter((s) => s.status === "reachable");

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <SectionTitle title="Local Models" sub="Run AI on your own machine. OmniForge finds the runtimes you have, lists their models with honest memory-fit estimates, and routes private work to them."
        right={<Button variant={scan ? "secondary" : "primary"} loading={scanning || modelsLoading} icon={<RefreshCw className="size-4" />} onClick={async () => { await run(); await refreshModels(); }}>{scan || bridgeState === "connected" ? "Rescan" : "Scan this computer"}</Button>} />

      {bridgeState !== "connected" && <div className="flex gap-3 rounded-xl border border-info/30 bg-info/10 p-3 text-[13px] text-info"><Info className="mt-0.5 size-4 shrink-0" /><p>Browsers often can't reach local servers (HTTPS pages, Safari, CORS). With the OmniForge desktop app, local model traffic is relayed securely and everything below works. Chrome/Firefox on <code>localhost</code> can still work if the server allows this origin.</p></div>}

      <section aria-label="System" className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4"><div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-faint"><Cpu className="size-3" />Processor</div><div className="mt-1 text-lg font-semibold">{bridgeInfo ? (bridgeInfo.system.appleSilicon ? "Apple Silicon" : bridgeInfo.system.arch) : "Unknown"}</div><p className="text-xs text-muted">{bridgeInfo ? `${bridgeInfo.system.cpus} cores${bridgeInfo.system.rosetta ? " · running under Rosetta (slower)" : ""}` : "Needs the desktop app"}</p></Card>
        <Card className="p-4"><div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-faint"><MemoryStick className="size-3" />Memory</div><div className="mt-1 text-lg font-semibold">{mem ? `${mem} GB` : "Unknown"}</div><p className="text-xs text-muted">{bridgeInfo ? `${bridgeInfo.system.memFreeGB.toFixed(1)} GB free now` : "Fit estimates need this"}</p></Card>
        <Card className="p-4"><div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-faint"><Zap className="size-3" />Runtimes online</div><div className="mt-1 text-lg font-semibold">{reachable.length}</div><p className="text-xs text-muted">{local.length} local model{local.length === 1 ? "" : "s"} available</p></Card>
      </section>

      <section aria-label="Runtimes" className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {Object.entries(INFO).map(([id, info]) => {
          const hits = services.filter((s) => s.presetId === id); const hit = hits.find((s) => s.status === "reachable") ?? hits.find((s) => s.status === "needs-auth");
          const added = !!hit && providers.some((p) => p.baseUrl === hit.baseUrl);
          return (
            <Card key={id}><CardBody className="space-y-3">
              <div className="flex items-start justify-between gap-2"><div><div className="flex items-center gap-2 text-sm font-semibold"><StatusDot tone={hit?.status === "reachable" ? "ok" : hit ? "warn" : "idle"} />{info.name}</div><p className="mt-0.5 text-xs text-muted">{info.blurb}</p></div>{hit?.status === "reachable" ? <Badge tone="ok">{hit.detail}</Badge> : hit?.status === "needs-auth" ? <Badge tone="warn">needs key</Badge> : id === "mlx" && bridgeInfo?.runtimes.mlx?.available ? <Badge tone="info">installed</Badge> : <Badge>not detected</Badge>}</div>
              {hit?.status === "reachable" ? <div className="flex items-center gap-2"><span className="truncate font-mono text-xs text-muted">{hit.baseUrl}{hit.version ? ` · v${hit.version}` : ""}</span><Button size="xs" variant={added ? "ghost" : "primary"} className="ml-auto" disabled={added} icon={added ? undefined : <Plus className="size-3.5" />} onClick={() => add(hit)}>{added ? "Added" : "Add"}</Button></div>
                : <div className="space-y-1.5"><div className="flex items-center gap-1 rounded-lg border border-line bg-bg px-2 py-1.5"><code className="min-w-0 flex-1 truncate text-xs text-muted">{info.install}</code><CopyButton text={info.install} label="" /></div><a href={info.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">Get {info.name}<ExternalLink className="size-3" /></a></div>}
            </CardBody></Card>
          );
        })}
      </section>

      <Card>
        <CardHeader><CardTitle>Installed models</CardTitle><span className="text-xs text-muted">{local.length}</span></CardHeader>
        {local.length === 0 ? <EmptyState icon={<Cpu className="size-5" />} title="No local models yet" body={reachable.length ? "A runtime is online but no provider is added yet — click Add on it above." : "Start a runtime above (Ollama is the quickest), pull a model, then Rescan."} />
          : <div className="overflow-x-auto"><table className="w-full text-[13px]"><thead className="border-b border-line text-left text-xs text-faint"><tr><th className="px-4 py-2 font-medium">Model</th><th className="px-2 py-2 font-medium">Size</th><th className="hidden px-2 py-2 font-medium sm:table-cell">Params · quant</th><th className="hidden px-2 py-2 font-medium md:table-cell">Context</th><th className="px-2 py-2 font-medium">Fits {mem ? `${mem} GB` : "?"}</th><th className="hidden px-2 py-2 font-medium lg:table-cell">Can do</th></tr></thead>
            <tbody className="divide-y divide-line">{local.map((m) => { const fit = mem ? fitsMemory(m, mem) : "unknown"; return <tr key={modelKey(m)}><td className="px-4 py-2"><div className="font-medium">{m.name ?? m.id}</div><div className="text-xs text-faint">{providers.find((p) => p.id === m.provider)?.label ?? m.provider}{m.loaded ? " · loaded" : ""}</div></td><td className="px-2 py-2 tabular-nums text-muted">{m.sizeBytes ? fmtBytes(m.sizeBytes) : "—"}</td><td className="hidden px-2 py-2 text-muted sm:table-cell">{[m.paramsB ? `${m.paramsB}B` : null, m.quantization].filter(Boolean).join(" · ") || "—"}</td><td className="hidden px-2 py-2 tabular-nums text-muted md:table-cell">{m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : "—"}</td><td className="px-2 py-2"><Badge tone={TONE[fit]} title={m.memoryGB ? `≈${m.memoryGB} GB needed (estimate)` : "Memory use isn't reported by this runtime"}>{fit === "unknown" ? "unknown" : fit === "too-large" ? "too large" : fit}</Badge></td><td className="hidden px-2 py-2 lg:table-cell"><span className="flex flex-wrap gap-1">{m.capabilities.map((c) => <Badge key={c} className={cn(m.capabilitySource === "heuristic" && "opacity-70")} title={m.capabilitySource === "heuristic" ? "Guessed from the model name — not reported by the runtime" : "Reported by the runtime"}>{c}{m.capabilitySource === "heuristic" ? "?" : ""}</Badge>)}</span></td></tr>; })}</tbody></table></div>}
      </Card>

      {local.length > 0 && <Card>
        <CardHeader><CardTitle>Best local model for each job</CardTitle><span className="text-xs text-muted">Optimising for {settings.optimise}</span></CardHeader>
        <ul className="divide-y divide-line">{(Object.keys(TASK_PROFILES) as TaskKind[]).map((t) => { const c = recs[t]; const assigned = settings.assignments[t]; return <li key={t} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]"><div className="w-48 shrink-0"><div className="font-medium">{TASK_PROFILES[t].label}</div><div className="text-xs text-faint">{TASK_PROFILES[t].hint}</div></div><div className="min-w-0 flex-1">{c ? <><span className="font-medium">{c.model.name ?? c.model.id}</span><span className="ml-2 text-xs text-muted">{c.reasons[0]}</span></> : <span className="text-muted">No installed model has the needed capabilities ({TASK_PROFILES[t].needs.join(", ")}).</span>}</div>{c && <Button size="xs" variant={assigned === modelKey(c.model) ? "soft" : "ghost"} onClick={() => patchSettings({ assignments: { ...settings.assignments, [t]: modelKey(c.model) } })}>{assigned === modelKey(c.model) ? "Assigned" : "Use for this"}</Button>}</li>; })}</ul>
      </Card>}
      <p className="text-xs text-faint">Memory fit is an estimate (model size plus overhead vs. total RAM). Capabilities marked “?” are guessed from the model name because the runtime doesn't report them. {LOCAL_CANDIDATES.length} well-known local ports are probed; nothing is sent off your machine.{bridge ? "" : ""}</p>
    </div>
  );
}
