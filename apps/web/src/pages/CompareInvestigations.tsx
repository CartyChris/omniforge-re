import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowLeft, GitCompare } from "lucide-react";
import { compareInvestigations, type Investigation, type SetDiff } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Select } from "@/components/ui/overlay";

const pct = (n: number) => `${Math.round(n * 100)}%`;

function Sets({ title, d, extra }: { title: string; d: SetDiff; extra?: React.ReactNode }) {
  const col = (label: string, items: string[], tone: "info" | "ok" | "neutral") => (
    <div className="min-w-0 space-y-1.5"><div className="flex items-center gap-1.5 text-xs font-medium text-muted">{label}<Badge tone={tone}>{items.length}</Badge></div>
      {items.length ? <ul className="max-h-48 space-y-0.5 overflow-auto font-mono text-xs">{items.slice(0, 200).map((x) => <li key={x} className="truncate" title={x}>{x}</li>)}{items.length > 200 && <li className="text-faint">+{items.length - 200} more</li>}</ul> : <p className="text-xs text-faint">—</p>}</div>
  );
  return (
    <Card><CardHeader><CardTitle>{title}</CardTitle><span className="text-xs text-muted" title="Shared ÷ all distinct items across both">overlap {pct(d.overlap)}</span></CardHeader>
      <CardBody className="space-y-3"><div className="grid gap-4 sm:grid-cols-3">{col("Only in A", d.onlyA, "info")}{col("In both", d.both, "ok")}{col("Only in B", d.onlyB, "neutral")}</div>{extra}</CardBody></Card>
  );
}
const Drift = ({ rows }: { rows: { name: string; a?: string; b?: string }[] }) => (rows.length ? <div className="rounded-lg border border-line p-2 text-xs"><p className="mb-1 font-medium text-muted">Different versions</p>{rows.map((r) => <div key={r.name} className="flex gap-2 font-mono"><span>{r.name}</span><span className="text-faint">{r.a} → {r.b}</span></div>)}</div> : null);

export default function CompareInvestigations() {
  const { project } = useApp(); const [sp, setSp] = useSearchParams();
  const all = useMemo(() => ((project?.investigations ?? []) as unknown as Investigation[]).slice().sort((x, y) => y.startedAt.localeCompare(x.startedAt)), [project]);
  const A = all.find((i) => i.id === sp.get("a")), B = all.find((i) => i.id === sp.get("b"));
  const c = useMemo(() => (A && B ? compareInvestigations(A, B) : null), [A, B]);
  const opts = all.map((i) => ({ value: i.id, label: i.name, hint: i.targets[0]?.value }));
  const set = (k: "a" | "b", v: string) => { const n = new URLSearchParams(sp); n.set(k, v); setSp(n, { replace: true }); };
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <Link to="/investigations" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg"><ArrowLeft className="size-3.5" />Investigations</Link>
      <SectionTitle title="Compare" sub="Two websites, two apps, or two versions of one. Every row comes from the recorded analyses; a name match between features is a hint, not proof of identical behaviour." />
      <div className="grid gap-3 sm:grid-cols-2"><Select label="Investigation A" value={A?.id ?? ""} onValueChange={(v) => set("a", v)} options={opts} placeholder="Choose A" /><Select label="Investigation B" value={B?.id ?? ""} onValueChange={(v) => set("b", v)} options={opts} placeholder="Choose B" /></div>
      {!c ? <Card><EmptyState icon={<GitCompare className="size-5" />} title={all.length < 2 ? "You need two investigations" : "Pick two investigations"} body={all.length < 2 ? "Run a second analysis, then compare." : "Choose A and B above."} /></Card> : <>
        <Card><CardBody className="overflow-x-auto"><table className="w-full text-sm" data-testid="compare-totals"><thead><tr className="text-left text-xs text-muted"><th className="py-1 font-medium">Measure</th><th className="font-medium">A · {c.a.name}</th><th className="font-medium">B · {c.b.name}</th></tr></thead>
          <tbody>{[{ label: "coverage", a: pct(c.coverage.a), b: pct(c.coverage.b) }, ...c.totals].map((t) => <tr key={t.label} className="border-t border-line"><td className="py-1.5 capitalize text-muted">{t.label}</td><td className="tabular-nums">{t.a}</td><td className="tabular-nums">{t.b}</td></tr>)}</tbody></table></CardBody></Card>
        <Sets title="Stack" d={c.stack} extra={<Drift rows={c.stack.versionDiffs} />} />
        <Card><CardHeader><CardTitle>Features</CardTitle><span className="text-xs text-muted">{c.features.matched.length} matched · overlap {pct(c.features.overlap)}</span></CardHeader>
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5"><p className="text-xs font-medium text-muted">Only in A ({c.features.onlyA.length})</p><ul className="space-y-0.5 text-[13px]">{c.features.onlyA.map((f) => <li key={f.id}>{f.name}</li>)}{!c.features.onlyA.length && <li className="text-faint">—</li>}</ul></div>
            <div className="space-y-1.5"><p className="text-xs font-medium text-muted">Matched ({c.features.matched.length})</p><ul className="space-y-0.5 text-[13px]">{c.features.matched.map((m) => <li key={m.a.id + m.b.id}>{m.a.name}{m.a.name !== m.b.name && <span className="text-faint"> ≈ {m.b.name}</span>}{m.how === "similar-name" && <Badge className="ml-1.5">similar</Badge>}</li>)}{!c.features.matched.length && <li className="text-faint">—</li>}</ul></div>
            <div className="space-y-1.5"><p className="text-xs font-medium text-muted">Only in B ({c.features.onlyB.length})</p><ul className="space-y-0.5 text-[13px]">{c.features.onlyB.map((f) => <li key={f.id}>{f.name}</li>)}{!c.features.onlyB.length && <li className="text-faint">—</li>}</ul></div>
          </CardBody></Card>
        <Sets title="Pages & routes" d={c.routes} /><Sets title="API endpoints" d={c.endpoints} /><Sets title="Dependencies" d={c.dependencies} extra={<Drift rows={c.dependencies.versionDiffs} />} /><Sets title="Third-party services" d={c.thirdParties} />
        <Card><CardHeader><CardTitle>Findings by area</CardTitle></CardHeader><CardBody>{c.findings.length === 0 ? <p className="text-[13px] text-muted">No findings in either.</p> : <table className="w-full text-sm"><tbody>{c.findings.map((f) => <tr key={f.area} className="border-t border-line first:border-0"><td className="py-1.5 capitalize text-muted">{f.area}</td><td className="tabular-nums">{f.a}</td><td className="tabular-nums">{f.b}</td></tr>)}</tbody></table>}</CardBody></Card>
      </>}
    </div>
  );
}
