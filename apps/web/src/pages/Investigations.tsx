import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowUpRight, Microscope, Plus, Search, Trash2 } from "lucide-react";
import type { Investigation } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { ago } from "@/lib/utils";
import { Badge, Button, Card, EmptyState, Input, Segmented, SectionTitle } from "@/components/ui/primitives";
import { CoverageRing, StatusBadge, TechChips } from "@/components/domain/bits";

export default function Investigations() {
  const { project, removeInvestigation } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState(""); const [f, setF] = useState<"all" | "web" | "source" | "attention">("all");
  const all = useMemo(() => ((project?.investigations ?? []) as unknown as Investigation[]).slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [project]);
  const rows = all.filter((i) => (f === "all" || (f === "web" ? i.pages.length > 0 : f === "source" ? i.pages.length === 0 : ["error", "interrupted", "cancelled"].includes(i.status))) && (!q || (i.name + i.targets.map((t) => t.value).join(" ")).toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <SectionTitle title="Investigations" sub="Every analysis you've run in this project. Open one for pages, stack, features, graphs, findings and the evidence behind each." right={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav("/analyze")}>New</Button>} />
      {all.length > 0 && <div className="flex flex-wrap items-center justify-between gap-3"><div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-faint" /><Input className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search investigations…" aria-label="Search investigations" /></div><Segmented size="sm" value={f} onChange={setF} options={[{ value: "all", label: `All ${all.length}` }, { value: "web", label: "Websites" }, { value: "source", label: "Source" }, { value: "attention", label: "Needs attention" }]} /></div>}
      {all.length === 0 ? <Card><EmptyState icon={<Microscope className="size-5" />} title="No investigations yet" body="Paste a website or GitHub repo, or drop a folder or ZIP, to start one." action={<Button variant="primary" onClick={() => nav("/analyze")}>Analyze something</Button>} /></Card>
        : rows.length === 0 ? <Card><EmptyState title="Nothing matches" body="Try a different search or filter." /></Card>
        : <div className="grid gap-3 md:grid-cols-2">{rows.map((i) => (
          <Card key={i.id} className="group relative transition hover:border-line-strong hover:bg-elevated">
            <Link to={`/investigations/${i.id}`} className="flex gap-3 p-4">
              <CoverageRing value={i.coverage.score} size={52} />
              <div className="min-w-0 flex-1 space-y-2"><div className="flex items-center gap-2"><span className="truncate text-sm font-semibold">{i.name}</span><StatusBadge s={i.status} /></div><p className="truncate text-xs text-muted">{i.targets.map((t) => t.value).join(" · ")}</p><TechChips inv={i} max={4} />
                <div className="flex flex-wrap gap-1.5 text-xs text-muted"><Badge>{i.pages.length ? `${i.pages.length} pages` : `${i.files.length} files`}</Badge><Badge>{i.features.length} features</Badge><Badge>{i.findings.length} findings</Badge><span className="ml-auto self-center text-faint">{ago(i.startedAt)}</span></div></div>
              <ArrowUpRight className="size-4 shrink-0 text-faint transition group-hover:text-fg" />
            </Link>
            <button onClick={() => { if (window.confirm(`Delete “${i.name}”?`)) removeInvestigation(i.id); }} className="absolute right-2 top-2 hidden rounded-md p-1.5 text-faint transition hover:bg-bad/10 hover:text-bad group-hover:block" aria-label={`Delete ${i.name}`}><Trash2 className="size-3.5" /></button>
          </Card>))}</div>}
    </div>
  );
}
