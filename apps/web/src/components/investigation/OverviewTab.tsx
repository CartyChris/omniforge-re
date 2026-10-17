import { AlertTriangle, CheckCircle2, CircleDashed, CircleSlash, HelpCircle, Hammer, Puzzle, Wand2 } from "lucide-react";
import { useNavigate } from "react-router";
import { recommendations, type Investigation } from "@omniforge/core";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Stat } from "@/components/ui/primitives";
import { ConfidenceBar, CoverageRing, KindBadge } from "@/components/domain/bits";
import { fmtBytes, fmtNum } from "@/lib/utils";
import { EvidenceChips } from "./EvidenceLink";

const CHECK_ICON = { done: <CheckCircle2 className="size-4 text-ok" />, partial: <CircleDashed className="size-4 text-warn" />, skipped: <CircleSlash className="size-4 text-faint" />, unavailable: <HelpCircle className="size-4 text-faint" /> } as const;
const SEV = { high: "bad", medium: "warn", low: "info", info: "neutral" } as const;

export function OverviewTab({ inv, go }: { inv: Investigation; go: (tab: string) => void }) {
  const nav = useNavigate();
  const recs = recommendations(inv);
  const isWeb = inv.pages.length > 0;
  const top = [...inv.findings].sort((a, b) => ["high", "medium", "low", "info"].indexOf(a.severity) - ["high", "medium", "low", "info"].indexOf(b.severity)).slice(0, 5);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="col-span-2 flex items-center gap-4 p-4 lg:col-span-1"><CoverageRing value={inv.coverage.score} size={64} /><div><div className="text-sm font-medium">Coverage</div><p className="text-xs text-muted">Done checks ÷ applicable checks. Never guessed.</p></div></Card>
        <Card className="p-4"><Stat label={isWeb ? "Pages" : "Files"} value={fmtNum(isWeb ? inv.pages.length : inv.files.length)} sub={`${fmtNum(inv.assets.length)} assets · ${fmtBytes(inv.pages.reduce((n, p) => n + p.bytes, 0))}`} /></Card>
        <Card className="p-4"><Stat label="Technologies" value={inv.technologies.length} sub={`${inv.dependencies.length} dependencies`} /></Card>
        <Card className="p-4"><Stat label="Features" value={inv.features.length} sub={`${inv.evidence.length} evidence · ${inv.endpoints.length} endpoints`} /></Card>
      </div>

      {inv.summary && <Card><CardHeader><CardTitle>AI summary</CardTitle><Badge tone="warn" title="Written by a model from the evidence below; verify before relying on it">AI-generated · inferred</Badge></CardHeader><CardBody className="whitespace-pre-line text-sm leading-relaxed">{inv.summary}</CardBody></Card>}

      <Card>
        <CardHeader><CardTitle>What to do next</CardTitle></CardHeader>
        <CardBody className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Button variant="primary" icon={<Hammer className="size-4" />} onClick={() => nav(`/studio?inv=${inv.id}&tab=rebuild`)}>Rebuild this app</Button>
          <Button variant="secondary" icon={<Puzzle className="size-4" />} onClick={() => nav(`/studio?inv=${inv.id}&tab=extract`)}>Extract features</Button>
          <Button variant="secondary" icon={<Wand2 className="size-4" />} onClick={() => go("ask")}>Ask the AI investigator</Button>
          <Button variant="secondary" onClick={() => go("report")}>Export report</Button>
        </CardBody>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Coverage checks</CardTitle><span className="text-xs text-muted">{inv.coverage.checks.filter((c) => c.status === "done").length}/{inv.coverage.checks.length} done</span></CardHeader>
          <ul className="divide-y divide-line">{inv.coverage.checks.map((c) => <li key={c.id} className="flex items-start gap-3 px-4 py-2.5">{CHECK_ICON[c.status]}<div className="min-w-0"><div className="text-[13px] font-medium">{c.label}</div><div className="text-xs text-muted">{c.detail}</div></div></li>)}</ul>
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle>Top findings</CardTitle><Button size="xs" variant="ghost" onClick={() => go("findings")}>All {inv.findings.length}</Button></CardHeader>
            {top.length === 0 ? <CardBody className="text-[13px] text-muted">No issues were flagged by the checks that ran.</CardBody> : <ul className="divide-y divide-line">{top.map((f) => <li key={f.id} className="space-y-1 px-4 py-2.5"><div className="flex items-center gap-2"><Badge tone={SEV[f.severity]}>{f.severity}</Badge><Badge>{f.area}</Badge><span className="truncate text-[13px] font-medium">{f.title}</span></div><p className="line-clamp-2 text-xs text-muted">{f.detail}</p><EvidenceChips ids={f.evidence} /></li>)}</ul>}
          </Card>
          {recs.length > 0 && <Card><CardHeader><CardTitle>Recommendations</CardTitle></CardHeader><ul className="list-disc space-y-1.5 px-8 py-3 text-[13px] text-muted">{recs.map((r, i) => <li key={i}>{r}</li>)}</ul></Card>}
        </div>
      </div>

      {(inv.limitations.length > 0 || inv.questions.length > 0) && (
        <div className="grid gap-5 lg:grid-cols-2">
          {inv.limitations.length > 0 && <Card><CardHeader><CardTitle className="flex items-center gap-2"><AlertTriangle className="size-4 text-warn" />Limits of this analysis</CardTitle></CardHeader><ul className="list-disc space-y-1.5 px-8 py-3 text-[13px] text-muted">{inv.limitations.slice(0, 20).map((l, i) => <li key={i}>{l}</li>)}</ul></Card>}
          {inv.questions.length > 0 && <Card><CardHeader><CardTitle className="flex items-center gap-2"><HelpCircle className="size-4 text-info" />Open questions</CardTitle></CardHeader><ul className="list-disc space-y-1.5 px-8 py-3 text-[13px] text-muted">{inv.questions.slice(0, 20).map((l, i) => <li key={i}>{l}</li>)}</ul></Card>}
        </div>
      )}
      <Card><CardBody className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted"><span className="font-medium text-fg">Provenance legend</span>{(["observed", "recovered", "dynamic", "reconstructed", "inferred", "unavailable"] as const).map((k) => <span key={k} className="flex items-center gap-1.5"><KindBadge kind={k} /></span>)}<ConfidenceBar value={0.8} /><span>= confidence from independent matching signals (not from an AI)</span></CardBody></Card>
    </div>
  );
}
