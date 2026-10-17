import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { BookmarkCheck, BookmarkPlus, Download, FilePlus2, GitCompare, Hammer, Puzzle, Search } from "lucide-react";
import type { Feature, Investigation } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { download } from "@/lib/utils";
import { Badge, Button, Card, EmptyState, Input, Segmented, SectionTitle } from "@/components/ui/primitives";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { ConfidenceBar, KindBadge } from "@/components/domain/bits";
import { EvidenceProvider } from "@/components/investigation/EvidenceLink";
import { FeatureDialog } from "@/components/investigation/DataTabs";

interface Row { inv: Investigation; f: Feature; key: string }
const specMd = (r: Row) => `# ${r.f.name}\n\n_${r.f.category} · ${r.f.provenance} · ${Math.round(r.f.confidence * 100)}% confidence · from ${r.inv.name}_\n\n${r.f.description}\n\n## Purpose\n${r.f.spec.purpose}\n\n${([["Inputs", r.f.spec.inputs], ["Outputs", r.f.spec.outputs], ["States", r.f.spec.states], ["Transitions", r.f.spec.transitions], ["Dependencies", r.f.spec.dependencies], ["Error states", r.f.spec.errorStates], ["Accessibility", r.f.spec.accessibility], ["Hypotheses (unverified)", r.f.spec.hypotheses]] as [string, string[]][]).filter(([, v]) => v.length).map(([k, v]) => `## ${k}\n${v.map((x) => `- ${x}`).join("\n")}`).join("\n\n")}\n`;

export default function FeatureLibrary() {
  const { project, mutate } = useApp(); const nav = useNavigate();
  const invs = (project?.investigations ?? []) as unknown as Investigation[];
  const rows: Row[] = useMemo(() => invs.flatMap((inv) => inv.features.map((f) => ({ inv, f, key: `${inv.id}:${f.id}` }))), [invs]);
  const pinned = new Set(project?.featureLibrary ?? []);
  const [q, setQ] = useState(""); const [cat, setCat] = useState("all"); const [only, setOnly] = useState<"all" | "saved">("all");
  const [sel, setSel] = useState<Row | null>(null); const [cmp, setCmp] = useState<string[]>([]); const [showCmp, setShowCmp] = useState(false);
  const cats = [...new Set(rows.map((r) => r.f.category))];
  const shown = rows.filter((r) => (cat === "all" || r.f.category === cat) && (only === "all" || pinned.has(r.key)) && (!q || (r.f.name + r.f.description + r.inv.name).toLowerCase().includes(q.toLowerCase())));
  const toggle = (k: string) => mutate((p) => ({ ...p, featureLibrary: pinned.has(k) ? p.featureLibrary.filter((x) => x !== k) : [...p.featureLibrary, k] }));
  const addToProject = (r: Row) => { mutate((p) => ({ ...p, workspace: { ...p.workspace, files: { ...p.workspace.files, [`features/${r.f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`]: specMd(r) } } })); toast.success("Spec added to the workspace under features/"); };
  const a = rows.find((r) => r.key === cmp[0]); const b = rows.find((r) => r.key === cmp[1]);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <SectionTitle title="Feature Library" sub="Every feature discovered across your investigations, as a reusable spec card. Save the ones you like, compare, re-create them in any stack, or add their specs to a project."
        right={cmp.length === 2 ? <Button variant="primary" icon={<GitCompare className="size-4" />} onClick={() => setShowCmp(true)}>Compare 2</Button> : cmp.length === 1 ? <span className="text-xs text-muted">Pick one more to compare</span> : undefined} />
      {rows.length === 0 ? <Card><EmptyState icon={<Puzzle className="size-5" />} title="No features yet" body="Analyze a website or repository — features are inferred from forms, routes, APIs and components, each with its evidence." action={<Button variant="primary" onClick={() => nav("/analyze")}>Analyze something</Button>} /></Card> : <>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-faint" /><Input className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search features…" aria-label="Search features" /></div>
          <div className="flex flex-wrap items-center gap-2"><Segmented size="sm" value={only} onChange={setOnly} options={[{ value: "all", label: `All ${rows.length}` }, { value: "saved", label: `Saved ${pinned.size}` }]} /><Segmented size="sm" value={cat} onChange={setCat} options={[{ value: "all", label: "Any type" }, ...cats.slice(0, 5).map((c) => ({ value: c, label: c }))]} className="max-w-full overflow-x-auto" /></div>
        </div>
        {shown.length === 0 ? <Card><EmptyState title="Nothing matches" body="Try another filter." /></Card> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{shown.map((r) => (
          <Card key={r.key} className="flex flex-col gap-3 p-4">
            <button className="space-y-2 text-left" onClick={() => setSel(r)}>
              <div className="flex items-start justify-between gap-2"><h3 className="text-sm font-semibold">{r.f.name}</h3><KindBadge kind={r.f.provenance} /></div>
              <p className="line-clamp-3 text-[13px] text-muted">{r.f.description}</p>
              <div className="flex items-center justify-between"><Badge>{r.f.category}</Badge><ConfidenceBar value={r.f.confidence} /></div>
              <p className="truncate text-[11px] text-faint">from {r.inv.name}</p>
            </button>
            <div className="mt-auto flex items-center gap-1 border-t border-line pt-3">
              <Button size="xs" variant="soft" icon={<Hammer className="size-3.5" />} onClick={() => nav(`/studio?inv=${r.inv.id}&feature=${r.f.id}&tab=extract`)}>Recreate</Button>
              <Button size="icon-sm" variant="ghost" aria-label={pinned.has(r.key) ? "Remove from saved" : "Save"} title={pinned.has(r.key) ? "Saved" : "Save to library"} onClick={() => toggle(r.key)}>{pinned.has(r.key) ? <BookmarkCheck className="size-4 text-ok" /> : <BookmarkPlus className="size-4" />}</Button>
              <Button size="icon-sm" variant="ghost" aria-label="Add spec to project" title="Add spec to the workspace" onClick={() => addToProject(r)}><FilePlus2 className="size-4" /></Button>
              <Button size="icon-sm" variant="ghost" aria-label="Export spec" title="Export spec (Markdown)" onClick={() => download(`${r.f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`, specMd(r), "text/markdown")}><Download className="size-4" /></Button>
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={cmp.includes(r.key)} disabled={!cmp.includes(r.key) && cmp.length >= 2} onChange={(e) => setCmp(e.target.checked ? [...cmp, r.key] : cmp.filter((x) => x !== r.key))} />compare</label>
            </div>
          </Card>))}</div>}
      </>}
      {sel && <EvidenceProvider inv={sel.inv}><FeatureDialog inv={sel.inv} f={sel.f} onClose={() => setSel(null)} /></EvidenceProvider>}
      <Dialog open={showCmp} onOpenChange={setShowCmp}>{a && b && <DialogContent title="Compare features" description={`${a.f.name} vs ${b.f.name}`} className="max-w-4xl"><div className="grid gap-4 md:grid-cols-2">{[a, b].map((r) => <div key={r.key} className="space-y-3 text-[13px]"><div className="space-y-1"><h3 className="text-sm font-semibold">{r.f.name}</h3><div className="flex items-center gap-2"><KindBadge kind={r.f.provenance} /><ConfidenceBar value={r.f.confidence} /></div><p className="text-muted">{r.f.description}</p><p className="text-xs text-faint">from {r.inv.name}</p></div>{([["Inputs", r.f.spec.inputs], ["Outputs", r.f.spec.outputs], ["States", r.f.spec.states], ["Dependencies", r.f.spec.dependencies]] as [string, string[]][]).map(([k, v]) => <div key={k}><div className="text-xs font-medium text-faint">{k}</div>{v.length ? <ul className="list-disc pl-5 text-muted">{v.slice(0, 8).map((x, i) => <li key={i} className={((k === "Dependencies" ? (r === a ? b : a).f.spec.dependencies : k === "Inputs" ? (r === a ? b : a).f.spec.inputs : k === "Outputs" ? (r === a ? b : a).f.spec.outputs : (r === a ? b : a).f.spec.states).includes(x)) ? "text-ok" : ""}>{x}</li>)}</ul> : <p className="text-faint">—</p>}</div>)}</div>)}</div><p className="mt-4 text-xs text-faint">Items in green appear in both features.</p></DialogContent>}</Dialog>
    </div>
  );
}
