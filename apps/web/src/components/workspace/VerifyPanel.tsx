import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, CircleAlert, ScanSearch, Wand2, XCircle } from "lucide-react";
import { repairBrief, task, type Investigation, type VerificationReport } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { audit } from "@/lib/audit";
import { runPlan } from "@/lib/ai";
import { openLocalWorkspace } from "@/lib/localfs";
import { Badge, Button, EmptyState, Field, Input, Segmented } from "@/components/ui/primitives";

type Images = Record<string, { reference: string; rebuilt: string; diff: string }>;
const TONE = { high: "bad", medium: "warn", low: "neutral" } as const;

/** Compare the rebuilt app (a running dev server) with the reference site, and hand the confirmed differences to the agent. Desktop only: it needs a real browser. */
export function VerifyPanel({ rootId, devUrl }: { rootId?: string; devUrl?: string }) {
  const { bridge, bridgeState, project, models } = useApp();
  const invs = (project?.investigations ?? []) as unknown as Investigation[];
  const firstWeb = invs.find((i) => i.pages.length > 0)?.targets[0]?.value ?? "";
  const [ref, setRef] = useState(firstWeb); const [reb, setReb] = useState(devUrl ?? "");
  useEffect(() => { if (devUrl && !reb) setReb(devUrl); }, [devUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!ref && firstWeb) setRef(firstWeb); }, [firstWeb]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState<"compare" | "repair" | null>(null); const [res, setRes] = useState<{ report: VerificationReport; images: Images } | null>(null);
  const [before, setBefore] = useState<{ high: number; medium: number } | null>(null); const [vp, setVp] = useState("desktop"); const [error, setError] = useState<string | null>(null);

  const compare = async () => {
    if (!bridge) return; setBusy("compare"); setError(null);
    try { const r = await bridge.post<{ report: VerificationReport; images: Images }>("/bridge/verify", { reference: ref.trim(), rebuilt: reb.trim() }); setRes(r); void audit("verification run", `${ref.trim()} vs ${reb.trim()} → ${r.report.summary.status}`); return r; }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const repair = async () => {
    if (!res || !rootId) return; setBusy("repair"); setBefore({ high: res.report.summary.high, medium: res.report.summary.medium });
    try {
      const local = await openLocalWorkspace(rootId);
      const t = task({ role: "uiux", objective: repairBrief(res.report), acceptance: [] });
      const done = await runPlan([t], { onUpdate: () => {}, local, brief: `Repair the rebuilt app so it matches ${res.report.reference}` });
      if (done[0]?.status !== "done") toast.warning(`The repair did not finish: ${done[0]?.logs.at(-1) ?? done[0]?.status}`); else toast.success(`Changed ${done[0]?.files?.length ?? 0} file(s). Re-checking…`);
      void audit("verification repair run", `${done[0]?.status}; ${done[0]?.files?.length ?? 0} files`);
      await new Promise((r) => setTimeout(r, 1500)); // let the dev server reload
    } catch (e) { toast.error((e as Error).message); setBusy(null); return; }
    setBusy(null); await compare();
  };
  const sorted = useMemo(() => (res ? [...res.report.discrepancies].sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity]) : []), [res]);
  const s = res?.report.summary; const img = res?.images[vp];
  const valid = /^https?:\/\//i.test(ref.trim()) && /^https?:\/\//i.test(reb.trim());

  if (bridgeState !== "connected" || !bridge) return <EmptyState icon={<ScanSearch className="size-5" />} title="Needs the macOS app" body="Comparing a rebuild with its reference renders both in a real browser, which the desktop app does for you. Everything stays on this Mac." />;
  return (
    <div className="space-y-3 p-3 text-[13px]">
      <p className="text-xs text-muted">Renders the reference and your running app at desktop and phone width, then lists what differs. Start your dev server first (Terminal tab).</p>
      <Field label="Reference site"><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="https://the-original.example" spellCheck={false} /></Field>
      <Field label="Your rebuilt app"><Input value={reb} onChange={(e) => setReb(e.target.value)} placeholder="http://localhost:5173" spellCheck={false} /></Field>
      <div className="flex flex-wrap gap-2"><Button variant="primary" size="sm" icon={<ScanSearch className="size-4" />} loading={busy === "compare"} disabled={!valid || !!busy} onClick={() => void compare()}>Compare</Button>
        {res && rootId && sorted.some((d) => d.severity !== "low") && <Button variant="secondary" size="sm" icon={<Wand2 className="size-4" />} loading={busy === "repair"} disabled={!!busy || !models.length} title={models.length ? "The agent edits files in your approved folder, then the comparison re-runs" : "Connect a model first"} onClick={() => void repair()}>Repair with AI</Button>}</div>
      {error && <div role="alert" className="rounded-lg border border-bad/30 bg-bad/10 p-2 text-xs text-bad">{error}</div>}
      {res && s && <div className="space-y-3" data-testid="verify-result">
        <div className="flex flex-wrap items-center gap-2">{s.status === "match" ? <CheckCircle2 className="size-4 text-ok" /> : s.status === "minor" ? <CircleAlert className="size-4 text-warn" /> : <XCircle className="size-4 text-bad" />}
          <span className="font-medium">{s.status === "match" ? "Matches the reference" : s.status === "minor" ? "Minor differences" : "Differs from the reference"}</span>
          <Badge tone="bad">{s.high} high</Badge><Badge tone="warn">{s.medium} medium</Badge><Badge>{s.low} low</Badge>
          {before && <span className="text-xs text-muted">before repair: {before.high} high, {before.medium} medium</span>}</div>
        <Segmented size="sm" value={vp} onChange={setVp} options={res.report.viewports.map((v) => ({ value: v.name, label: `${v.name} · ${(v.ratio * 100).toFixed(1)}%` }))} />
        {img && <div className="grid grid-cols-3 gap-2 text-[11px] text-muted">{(["reference", "rebuilt", "diff"] as const).map((k) => <figure key={k} className="min-w-0 space-y-1"><figcaption>{k === "diff" ? "differences" : k}</figcaption><img src={img[k]} alt={`${k === "diff" ? "differences" : k} at ${vp} width`} className="max-h-64 w-full rounded border border-line bg-white object-contain object-top" /></figure>)}</div>}
        {sorted.length === 0 ? <p className="text-muted">No differences found.</p> : <ul className="divide-y divide-line rounded-lg border border-line">{sorted.slice(0, 60).map((d) => <li key={d.id} className="flex items-start gap-2 px-3 py-2"><Badge tone={TONE[d.severity]}>{d.severity}</Badge><div className="min-w-0"><span className="text-faint">{d.area} · </span>{d.summary}</div></li>)}</ul>}
        <details className="text-xs text-muted"><summary className="cursor-pointer">What this does not check</summary><ul className="mt-1 list-disc space-y-0.5 pl-5">{res.report.limits.map((l) => <li key={l}>{l}</li>)}</ul></details>
      </div>}
    </div>
  );
}
