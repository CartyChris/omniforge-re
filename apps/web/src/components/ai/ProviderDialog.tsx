import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, ExternalLink, KeyRound, XCircle } from "lucide-react";
import { PRESETS, type ProviderConfig } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { vault } from "@/lib/vault";
import { keyName, newProviderConfig, refreshModels, testProvider } from "@/lib/ai";
import { Badge, Button, Field, Input } from "@/components/ui/primitives";
import { Dialog, DialogContent, Select } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";

const BLURB: Record<string, string> = { anthropic: "Claude models", openai: "GPT & reasoning models", gemini: "Gemini via OpenAI-compatible API", xai: "Grok models", moonshot: "Kimi models", openrouter: "One key, hundreds of models", ollama: "Local · port 11434", lmstudio: "Local · port 1234", llamacpp: "Local · llama-server", mlx: "Local · Apple MLX server", unsloth: "Local · Unsloth Studio API", vllm: "Local · vLLM", custom: "Any OpenAI-compatible endpoint" };

export function ProviderDialog({ open, onOpenChange, editing, initialPreset }: { open: boolean; onOpenChange: (v: boolean) => void; editing?: ProviderConfig; initialPreset?: string }) {
  const { providers, setProviders } = useApp();
  const [preset, setPreset] = useState(initialPreset ?? "anthropic");
  const [cfg, setCfg] = useState<ProviderConfig>(() => editing ?? newProviderConfig(initialPreset ?? "anthropic"));
  const [key, setKey] = useState("");
  const [keyStored, setKeyStored] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState("");

  useEffect(() => {
    if (!open) return;
    const c = editing ?? newProviderConfig(initialPreset ?? "anthropic");
    setCfg(c); setPreset(c.preset ?? "custom"); setKey(""); setTest(null); setManual((c.manualModels as any[] | undefined)?.map((m) => m.id).join(", ") ?? "");
    vault.get(keyName(c.id)).then((k) => setKeyStored(!!k)).catch(() => setKeyStored(false));
  }, [open, editing, initialPreset]);

  const p = PRESETS.find((x) => x.id === preset);
  const choose = (id: string) => { setPreset(id); setCfg(newProviderConfig(id, editing ? { id: cfg.id } : {})); setTest(null); };
  const run = async () => {
    setBusy(true); setTest(null);
    const k = key || (await vault.get(keyName(cfg.id)).catch(() => undefined));
    const r = await testProvider(cfg, k);
    setTest({ ok: r.ok, text: r.ok ? `Connected${r.version ? ` (v${r.version})` : ""} · ${r.models ?? 0} models · ${r.latencyMs} ms` : r.error ?? "Failed" });
    setBusy(false);
  };
  const save = async () => {
    setBusy(true);
    try {
      const manualModels = manual.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((id) => ({ id }));
      const next: ProviderConfig = { ...cfg, manualModels };
      if (key) await vault.set(keyName(next.id), key);
      setProviders([...providers.filter((x) => x.id !== next.id), next]);
      onOpenChange(false);
      toast.success(`${next.label} saved`);
      await refreshModels();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => { await vault.del(keyName(cfg.id)).catch(() => {}); setProviders(providers.filter((x) => x.id !== cfg.id)); onOpenChange(false); toast("Provider removed"); refreshModels(); };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={editing ? `Edit ${cfg.label}` : "Connect an AI provider"} description="Models are discovered from the provider — no list is hardcoded. Keys are encrypted on this device." className="max-w-2xl">
        <div className="space-y-5">
          {!editing && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {PRESETS.map((x) => (
                <button key={x.id} onClick={() => choose(x.id)} className={cn("rounded-xl border p-3 text-left transition", preset === x.id ? "border-accent bg-accent-soft" : "border-line bg-bg hover:border-line-strong")}>
                  <div className="flex items-center justify-between gap-1"><span className="truncate text-[13px] font-semibold">{x.label}</span>{x.local && <Badge tone="teal">local</Badge>}</div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted">{BLURB[x.id]}</p>
                </button>
              ))}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={cfg.label} onChange={(e) => setCfg({ ...cfg, label: e.target.value })} /></Field>
            <Field label="Endpoint" hint={p?.note}><Input value={cfg.baseUrl} onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })} spellCheck={false} /></Field>
            <Field label={`API key${p && !p.needsKey ? " (optional)" : ""}`} hint={keyStored && !key ? "A key is stored (encrypted). Leave blank to keep it." : "Stored encrypted on this device; never in project exports."} className="sm:col-span-2">
              <div className="relative"><KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" /><Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={keyStored ? "••••••••••••" : "sk-…"} className="pl-9" /></div>
            </Field>
            <Field label="Cost limit (USD)" hint="Stops calls once exceeded. Needs known model prices (OpenRouter reports them)."><Input type="number" min={0} step={0.5} value={cfg.maxCostUsd ?? ""} onChange={(e) => setCfg({ ...cfg, maxCostUsd: e.target.value ? Number(e.target.value) : undefined })} placeholder="No limit" /></Field>
            <Field label="Fallback provider" hint="Used when this one fails before answering.">
              <Select value={cfg.fallbackProviderId ?? "none"} onValueChange={(v) => setCfg({ ...cfg, fallbackProviderId: v === "none" ? undefined : v })} options={[{ value: "none", label: "None" }, ...providers.filter((x) => x.id !== cfg.id).map((x) => ({ value: x.id, label: x.label }))]} />
            </Field>
            <Field label="Context limit (tokens)" hint="Ollama: sets num_ctx."><Input type="number" min={512} value={cfg.contextLimit ?? ""} onChange={(e) => setCfg({ ...cfg, contextLimit: e.target.value ? Number(e.target.value) : undefined })} placeholder="Model default" /></Field>
            <Field label="Register models manually" hint="Comma-separated ids, if the endpoint cannot list them."><Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="my-model, other-model" /></Field>
          </div>
          {test && <div className={cn("flex items-start gap-2 rounded-lg border p-3 text-[13px]", test.ok ? "border-ok/30 bg-ok/10 text-ok" : "border-bad/30 bg-bad/10 text-bad")}>{test.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}<span className="whitespace-pre-line break-words">{test.text}</span></div>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">{editing && <Button variant="danger" onClick={remove}>Remove</Button>}{preset === "unsloth" && <Button variant="ghost" size="sm" onClick={() => setCfg({ ...cfg, baseUrl: cfg.baseUrl.includes("8888") ? "http://localhost:8000/v1" : "http://localhost:8888/v1" })}>Try other port ({cfg.baseUrl.includes("8888") ? "8000" : "8888"})</Button>}{p?.id === "anthropic" && <a className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Get a key <ExternalLink className="size-3" /></a>}</div>
            <div className="flex gap-2"><Button onClick={run} loading={busy}>Test connection</Button><Button variant="primary" onClick={save} loading={busy} disabled={!cfg.baseUrl || cfg.baseUrl === "https://"}>Save</Button></div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
