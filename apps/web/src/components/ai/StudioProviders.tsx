import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Bot, CheckCircle2, Pencil, Plus, RefreshCw, Search, XCircle } from "lucide-react";
import { PRESETS, ROLES, TASK_PROFILES, chooseModel, modelKey, type ProviderConfig, type ProviderStatus, type TaskKind } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { meters, refreshModels, testProvider } from "@/lib/ai";
import { vault } from "@/lib/vault";
import { keyName } from "@/lib/ai";
import { cn } from "@/lib/utils";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, Input, Segmented, StatusDot } from "@/components/ui/primitives";
import { Select, Switch } from "@/components/ui/overlay";
import { ProviderDialog } from "./ProviderDialog";

export function ProvidersPanel() {
  const { providers, setProviders, models, modelErrors, bridgeInfo, modelsLoading } = useApp();
  const [dlg, setDlg] = useState<{ editing?: ProviderConfig; preset?: string } | null>(null);
  const [health, setHealth] = useState<Record<string, ProviderStatus | "testing">>({});
  const check = async (c: ProviderConfig) => { setHealth((h) => ({ ...h, [c.id]: "testing" })); let key: string | undefined; try { key = await vault.get(keyName(c.id)); } catch { /* locked */ } const r = await testProvider(c, key).catch((e) => ({ ok: false, latencyMs: 0, error: (e as Error).message }) as ProviderStatus); setHealth((h) => ({ ...h, [c.id]: r })); };
  const clis = (bridgeInfo?.clis ?? []).filter((c: any) => c.status === "ready");
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-xl text-[13px] text-muted">Connect any mix of cloud and local models. OmniForge never hardcodes a model list — it asks each provider what it offers.</p><div className="flex gap-2"><Button variant="ghost" size="sm" loading={modelsLoading} icon={<RefreshCw className="size-4" />} onClick={() => refreshModels()}>Refresh models</Button><Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDlg({})}>Add provider</Button></div></div>
      {providers.length === 0 && clis.length === 0 ? <Card><EmptyState icon={<Bot className="size-5" />} title="No AI providers yet" body="Add an API key (Anthropic, OpenAI, Gemini, xAI, Moonshot, OpenRouter…) or a local runtime. Analysis, Repo Rip cloning and meshing work without any."
        action={<div className="flex flex-wrap justify-center gap-2">{["anthropic", "openai", "ollama", "openrouter"].map((id) => <Button key={id} variant="secondary" size="sm" onClick={() => setDlg({ preset: id })}>{PRESETS.find((p) => p.id === id)?.label}</Button>)}</div>} /></Card>
        : <div className="grid gap-3 md:grid-cols-2">
          {providers.map((c) => { const h = health[c.id]; const m = models.filter((x) => x.provider === c.id); const meter = meters.get(c.id); const err = modelErrors.find((e) => e.provider === c.label);
            return (
              <Card key={c.id} className={cn(c.enabled === false && "opacity-60")}><CardBody className="space-y-3">
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="flex items-center gap-2 text-sm font-semibold"><StatusDot tone={h && h !== "testing" ? (h.ok ? "ok" : "bad") : m.length ? "ok" : err ? "bad" : "idle"} />{c.label}</div><p className="mt-0.5 truncate font-mono text-xs text-faint">{c.baseUrl}</p></div><div className="flex items-center gap-1.5">{c.local && <Badge tone="teal">local</Badge>}<Switch checked={c.enabled !== false} onCheckedChange={(v) => { setProviders(providers.map((p) => (p.id === c.id ? { ...p, enabled: v } : p))); }} aria-label={`Enable ${c.label}`} /></div></div>
                <div className="flex flex-wrap gap-1.5 text-xs"><Badge>{m.length} model{m.length === 1 ? "" : "s"}</Badge>{c.maxCostUsd !== undefined && <Badge tone={meter && meter.costUsd >= c.maxCostUsd ? "bad" : "neutral"}>${(meter?.costUsd ?? 0).toFixed(2)} / ${c.maxCostUsd}</Badge>}{meter && meter.input + meter.output > 0 && <Badge>{Math.round((meter.input + meter.output) / 1000)}k tokens</Badge>}{c.fallbackProviderId && <Badge>fallback → {providers.find((p) => p.id === c.fallbackProviderId)?.label}</Badge>}</div>
                {h === "testing" ? <p className="text-xs text-muted">Testing…</p> : h ? <p className={cn("flex items-start gap-1.5 text-xs", h.ok ? "text-ok" : "text-bad")}>{h.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <XCircle className="mt-0.5 size-3.5 shrink-0" />}<span className="whitespace-pre-line break-words">{h.ok ? `Healthy · ${h.latencyMs} ms${h.models !== undefined ? ` · ${h.models} models` : ""}${h.version ? ` · v${h.version}` : ""}` : h.error}</span></p> : err ? <p className="flex items-start gap-1.5 text-xs text-bad"><XCircle className="mt-0.5 size-3.5 shrink-0" /><span className="break-words">{err.error}</span></p> : null}
                <div className="flex gap-1.5"><Button size="xs" variant="secondary" onClick={() => check(c)}>Test</Button><Button size="xs" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setDlg({ editing: c })}>Edit</Button></div>
              </CardBody></Card>); })}
          {clis.map((c: any) => <Card key={c.id}><CardBody className="space-y-2"><div className="flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-semibold"><StatusDot tone="ok" />{c.name}</div><Badge tone="teal">CLI</Badge></div><p className="text-xs text-muted">Agentic CLI found on your Mac{c.version ? ` (v${c.version})` : ""}. Available as a model in plans and chat; uses your existing login.</p></CardBody></Card>)}
        </div>}
      {dlg && <ProviderDialog open onOpenChange={(o) => { if (!o) setDlg(null); }} editing={dlg.editing} initialPreset={dlg.preset} />}
    </div>
  );
}

export function ModelsPanel() {
  const { models, providers } = useApp(); const [q, setQ] = useState(""); const [f, setF] = useState<"all" | "local" | "cloud" | "vision" | "tools">("all");
  const rows = models.filter((m) => (f === "all" || (f === "local" ? m.local : f === "cloud" ? !m.local : m.capabilities.includes(f))) && (!q || `${m.name ?? ""} ${m.id} ${m.provider}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-faint" /><Input className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models…" aria-label="Search models" /></div><Segmented size="sm" value={f} onChange={setF} options={[{ value: "all", label: `All ${models.length}` }, { value: "cloud", label: "Cloud" }, { value: "local", label: "Local" }, { value: "vision", label: "Vision" }, { value: "tools", label: "Tools" }]} /></div>
      <Card className="overflow-hidden">{rows.length === 0 ? <EmptyState title="No models" body="Connect a provider first, or relax the filter." /> : <div className="max-h-[65dvh] overflow-auto"><table className="w-full text-[13px]"><thead className="sticky top-0 border-b border-line bg-surface text-left text-xs text-faint"><tr><th className="px-4 py-2 font-medium">Model</th><th className="px-2 py-2 font-medium">Provider</th><th className="hidden px-2 py-2 font-medium sm:table-cell">Context</th><th className="hidden px-2 py-2 font-medium md:table-cell">$/M in·out</th><th className="hidden px-2 py-2 font-medium lg:table-cell">Capabilities</th></tr></thead><tbody className="divide-y divide-line">{rows.slice(0, 400).map((m) => <tr key={modelKey(m)}><td className="px-4 py-2"><div className="font-medium">{m.name ?? m.id}</div>{m.name && m.name !== m.id && <div className="font-mono text-[11px] text-faint">{m.id}</div>}</td><td className="px-2 py-2 text-muted">{providers.find((p) => p.id === m.provider)?.label ?? m.provider.replace(/^cli:/, "")}{m.local && <Badge tone="teal" className="ml-1.5">local</Badge>}</td><td className="hidden px-2 py-2 tabular-nums text-muted sm:table-cell">{m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : "—"}</td><td className="hidden px-2 py-2 tabular-nums text-muted md:table-cell">{m.pricePerMTok ? `${m.pricePerMTok.input}·${m.pricePerMTok.output}` : "—"}</td><td className="hidden px-2 py-2 lg:table-cell"><span className="flex flex-wrap gap-1">{m.capabilities.map((c) => <Badge key={c} className={cn(m.capabilitySource === "heuristic" && "opacity-70")} title={m.capabilitySource === "heuristic" ? "Guessed from the name" : "Reported by the provider"}>{c}{m.capabilitySource === "heuristic" ? "?" : ""}</Badge>)}</span></td></tr>)}</tbody></table></div>}</Card>
    </div>
  );
}

export function RoutingPanel() {
  const { models, settings, patchSettings } = useApp();
  const prefs = useMemo(() => ({ privacy: settings.localOnly ? "local-only" as const : "any" as const, optimise: settings.optimise, assignments: {} }), [settings.localOnly, settings.optimise]);
  return (
    <div className="space-y-4">
      <Card><CardBody className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-sm font-medium">Automatic routing</p><p className="text-xs text-muted">Pick a model per job type, or leave it on Auto and OmniForge chooses by capability, privacy, cost and speed.</p></div><Segmented value={settings.optimise} onChange={(optimise) => patchSettings({ optimise })} options={[{ value: "quality", label: "Quality" }, { value: "cost", label: "Cost" }, { value: "latency", label: "Speed" }]} /></CardBody></Card>
      <Card><ul className="divide-y divide-line">{(Object.keys(TASK_PROFILES) as TaskKind[]).map((t) => { const auto = chooseModel(t, models, prefs); const assigned = settings.assignments[t];
        return (<li key={t} className="flex flex-wrap items-center gap-3 px-4 py-3"><div className="w-full sm:w-56"><p className="text-sm font-medium">{TASK_PROFILES[t].label}</p><p className="text-xs text-faint">{TASK_PROFILES[t].hint}</p></div>
          <div className="min-w-0 flex-1 sm:max-w-sm"><Select label={`Model for ${TASK_PROFILES[t].label}`} value={assigned ?? "auto"} onValueChange={(v) => { const a = { ...settings.assignments }; if (v === "auto") delete a[t]; else a[t] = v; patchSettings({ assignments: a }); }} options={[{ value: "auto", label: auto ? `Auto → ${auto.model.name ?? auto.model.id}` : "Auto (no suitable model)" }, ...models.filter((m) => !settings.localOnly || m.local).map((m) => ({ value: modelKey(m), label: `${m.name ?? m.id}`, hint: m.provider.replace(/^cli:/, "") }))]} /></div>
          {!assigned && auto && <span className="hidden text-xs text-muted lg:block">{auto.reasons[0]}</span>}</li>); })}</ul></Card>
      {models.length === 0 && <p className="text-xs text-warn">No models available yet — add a provider first.</p>}
    </div>
  );
}

export function AgentsPanel() {
  return (
    <div className="grid gap-3 md:grid-cols-2">{Object.entries(ROLES).map(([id, r]) => (
      <Card key={id}><CardBody className="space-y-2.5"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{r.label}</h3><Badge tone="accent">{TASK_PROFILES[r.kind].label}</Badge></div><p className="text-[13px] leading-relaxed text-muted">{r.system}</p><div className="flex flex-wrap gap-1.5">{r.tools.map((t) => <Badge key={t} tone={t === "run_command" ? "warn" : "neutral"} title={t === "run_command" ? "Gated: every command needs your approval" : undefined}>{t}</Badge>)}</div></CardBody></Card>))}
    </div>
  );
}
