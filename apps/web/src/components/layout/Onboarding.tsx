import { useState } from "react";
import { ArrowRight, Cloud, Cpu, HardDrive, ShieldCheck } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/primitives";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { ProviderDialog } from "@/components/ai/ProviderDialog";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router";
import { Logo } from "./Logo";

/** First-run: privacy mode → connect AI → done. Every step is skippable; nothing is required to start analysing. */
export function Onboarding() {
  const { settings, patchSettings, models } = useApp();
  const [step, setStep] = useState(0);
  const [addProvider, setAddProvider] = useState(false);
  const nav = useNavigate();
  const open = !settings.onboarded;
  const finish = (to?: string) => { patchSettings({ onboarded: true }); if (to) nav(to); };
  return (
    <>
      <Dialog open={open && !addProvider} onOpenChange={(o) => { if (!o) finish(); }}>
        <DialogContent title="Welcome to OmniForge RE" className="max-w-lg">
          <div className="space-y-5">
            <div className="flex items-center gap-3"><Logo className="size-12" /><p className="text-sm leading-relaxed text-muted">Analyse any website, repository, package or binary — then rebuild, extract or improve it with AI. Three quick choices, all changeable later.</p></div>
            {step === 0 && (
              <div className="space-y-3 animate-in">
                <p className="text-sm font-medium">How should AI be allowed to run?</p>
                {[{ v: false, i: Cloud, t: "Cloud + local models", d: "Best quality. Content you analyse may be sent to the model providers you connect." }, { v: true, i: ShieldCheck, t: "Local-only (privacy mode)", d: "Only models on this computer. Nothing leaves your machine, except the pages you ask to crawl." }].map((o) => (
                  <button key={String(o.v)} onClick={() => patchSettings({ localOnly: o.v })} className={cn("flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition", settings.localOnly === o.v ? "border-accent bg-accent-soft" : "border-line bg-bg hover:border-line-strong")}><o.i className="mt-0.5 size-5 shrink-0 text-accent" /><span><span className="block text-sm font-semibold">{o.t}</span><span className="mt-0.5 block text-xs text-muted">{o.d}</span></span></button>
                ))}
                <div className="flex justify-end"><Button variant="primary" onClick={() => setStep(1)} icon={<ArrowRight className="size-4" />}>Continue</Button></div>
              </div>
            )}
            {step === 1 && (
              <div className="space-y-3 animate-in">
                <p className="text-sm font-medium">Connect an AI model <span className="font-normal text-muted">(optional — analysis works without one)</span></p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button onClick={() => setAddProvider(true)} className="flex items-start gap-3 rounded-xl border border-line bg-bg p-3.5 text-left transition hover:border-line-strong"><Cloud className="mt-0.5 size-5 text-accent" /><span><span className="block text-sm font-semibold">Add a provider</span><span className="mt-0.5 block text-xs text-muted">Anthropic, OpenAI, Gemini, xAI, Kimi, OpenRouter…</span></span></button>
                  <button onClick={() => finish("/models")} className="flex items-start gap-3 rounded-xl border border-line bg-bg p-3.5 text-left transition hover:border-line-strong"><Cpu className="mt-0.5 size-5 text-teal" /><span><span className="block text-sm font-semibold">Find local models</span><span className="mt-0.5 block text-xs text-muted">Ollama, LM Studio, llama.cpp, MLX, Unsloth</span></span></button>
                </div>
                {models.length > 0 && <p className="text-xs text-ok">{models.length} models available.</p>}
                <div className="flex items-center justify-between"><Button variant="ghost" onClick={() => setStep(0)}>Back</Button><Button variant="primary" onClick={() => setStep(2)} icon={<ArrowRight className="size-4" />}>{models.length ? "Continue" : "Skip for now"}</Button></div>
              </div>
            )}
            {step === 2 && (
              <div className="space-y-3 animate-in">
                <div className="flex items-start gap-3 rounded-xl border border-line bg-bg p-3.5"><HardDrive className="mt-0.5 size-5 text-info" /><div><p className="text-sm font-semibold">Desktop companion</p><p className="mt-0.5 text-xs leading-relaxed text-muted">The macOS app adds local folders, installed-app inspection, REA reverse engineering, AI CLIs and local models. You can pair it later from Integrations.</p></div></div>
                <div className="flex items-center justify-between"><Button variant="ghost" onClick={() => setStep(1)}>Back</Button><div className="flex gap-2"><Button onClick={() => finish("/integrations")}>Pair now</Button><Button variant="primary" onClick={() => finish("/analyze")}>Start analysing</Button></div></div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <ProviderDialog open={addProvider} onOpenChange={(o) => { setAddProvider(o); }} />
    </>
  );
}
