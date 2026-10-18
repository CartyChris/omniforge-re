import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { BookmarkPlus, BookmarkCheck, ChevronRight, Copy, FileCode2, Hammer, Search, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { Feature, Investigation, Page, SourceFile } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { ago, cn, fmtBytes, fmtNum, pathOf } from "@/lib/utils";
import { runVulnerabilityCheck } from "@/lib/vuln";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, Input, Segmented } from "@/components/ui/primitives";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { ConfidenceBar, KindBadge } from "@/components/domain/bits";
import { EvidenceChips, useEvidence } from "./EvidenceLink";

const SEV = { high: "bad", medium: "warn", low: "info", info: "neutral" } as const;
const statusColor = (s: number) => (s >= 200 && s < 300 ? "text-ok" : s >= 300 && s < 400 ? "text-info" : "text-bad");
function Filter({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-faint" /><Input className="pl-8" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} /></div>;
}
const More = ({ n, total, onMore }: { n: number; total: number; onMore: () => void }) => (n < total ? <div className="flex justify-center p-3"><Button size="sm" variant="ghost" onClick={onMore}>Show {Math.min(100, total - n)} more ({total - n} left)</Button></div> : null);

/* ------------------------------ Pages ------------------------------ */
export function PagesTab({ inv }: { inv: Investigation }) {
  const [q, setQ] = useState(""); const [n, setN] = useState(100); const [sel, setSel] = useState<Page | null>(null);
  const rows = useMemo(() => inv.pages.filter((p) => !q || (p.url + p.title).toLowerCase().includes(q.toLowerCase())), [inv.pages, q]);
  if (!inv.pages.length) return <EmptyState title="No pages" body="This investigation analysed files rather than a website." />;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3"><Filter value={q} onChange={setQ} placeholder="Filter pages…" /><span className="text-xs text-muted">{rows.length} of {inv.pages.length}</span></div>
      <Card className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-[13px]"><thead className="border-b border-line text-left text-xs text-faint"><tr><th className="px-4 py-2 font-medium">Status</th><th className="px-2 py-2 font-medium">Path</th><th className="hidden px-2 py-2 font-medium md:table-cell">Title</th><th className="hidden px-2 py-2 font-medium sm:table-cell">Depth</th><th className="hidden px-2 py-2 text-right font-medium sm:table-cell">Size</th><th className="hidden px-2 py-2 font-medium lg:table-cell">Found via</th><th className="px-2" /></tr></thead>
        <tbody className="divide-y divide-line">{rows.slice(0, n).map((p) => <tr key={p.id} onClick={() => setSel(p)} className="cursor-pointer transition hover:bg-elevated"><td className={cn("px-4 py-2 font-mono text-xs", statusColor(p.status))}>{p.status || "ERR"}</td><td className="max-w-[16rem] truncate px-2 py-2" title={p.url}>{pathOf(p.url)}</td><td className="hidden max-w-[18rem] truncate px-2 py-2 text-muted md:table-cell">{p.title || "—"}</td><td className="hidden px-2 py-2 tabular-nums text-muted sm:table-cell">{p.depth}</td><td className="hidden px-2 py-2 text-right tabular-nums text-muted sm:table-cell">{fmtBytes(p.bytes)}</td><td className="hidden px-2 py-2 lg:table-cell"><Badge>{p.discoveredVia}</Badge></td><td className="px-2 text-faint"><ChevronRight className="size-4" /></td></tr>)}</tbody></table></div>
        <More n={n} total={rows.length} onMore={() => setN(n + 100)} />
      </Card>
      <Dialog open={!!sel} onOpenChange={(o) => !o && setSel(null)}>{sel && (
        <DialogContent side="right" title={sel.title || pathOf(sel.url)} description={sel.url}>
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap gap-2"><Badge tone={sel.status < 300 ? "ok" : "bad"}>{sel.status || "error"}</Badge><Badge>{sel.contentType || "?"}</Badge><Badge>{fmtBytes(sel.bytes)}</Badge><Badge>{sel.ms} ms</Badge><Badge>depth {sel.depth}</Badge></div>
            {sel.error && <p className="text-bad">{sel.error}</p>}
            {sel.text && <Section title={`Page text${sel.textTruncated ? " (truncated)" : ""}`}><pre tabIndex={0} aria-label="Page text as Markdown" data-testid="page-text" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-overlay p-3 font-mono text-xs">{sel.text}</pre></Section>}
            <Section title={`Headings (${sel.headings.length})`}>{sel.headings.slice(0, 20).map((h, i) => <div key={i} className="truncate text-[13px]" style={{ paddingLeft: (h.level - 1) * 12 }}><span className="mr-1.5 text-faint">h{h.level}</span>{h.text}</div>)}</Section>
            <Section title={`Forms (${sel.forms.length})`}>{sel.forms.map((f, i) => <div key={i} className="rounded-lg border border-line p-2.5 text-[13px]"><div className="font-medium">{f.method.toUpperCase()} <span className="font-mono text-xs text-muted">{f.action || "(same page)"}</span></div><div className="mt-1 flex flex-wrap gap-1.5">{f.fields.map((x, j) => <Badge key={j} title={x.label}>{x.name || x.type}{x.required ? " *" : ""}</Badge>)}</div></div>)}</Section>
            <Section title="Accessibility signals"><div className="flex flex-wrap gap-2 text-[13px]"><Badge tone={sel.a11y.hasLang ? "ok" : "warn"}>lang {sel.a11y.hasLang ? "set" : "missing"}</Badge><Badge tone={sel.a11y.hasMain ? "ok" : "warn"}>{sel.a11y.hasMain ? "has <main>" : "no <main>"}</Badge><Badge tone={sel.a11y.imagesWithoutAlt ? "warn" : "ok"}>{sel.a11y.imagesWithoutAlt} images w/o alt</Badge><Badge tone={sel.a11y.inputsWithoutLabel ? "warn" : "ok"}>{sel.a11y.inputsWithoutLabel} unlabelled inputs</Badge></div></Section>
            <Section title="Interactive elements"><div className="flex flex-wrap gap-2 text-[13px]"><Badge>{sel.interactive.links} links</Badge><Badge>{sel.interactive.buttons} buttons</Badge><Badge>{sel.interactive.inputs} inputs</Badge><Badge>{sel.interactive.dialogs} dialogs</Badge></div></Section>
            <Section title={`Scripts (${sel.scripts.length})`}>{sel.scripts.slice(0, 15).map((s) => <div key={s} className="truncate font-mono text-xs text-muted" title={s}>{pathOf(s)}</div>)}</Section>
            <Section title="Meta">{Object.entries(sel.meta).slice(0, 12).map(([k, v]) => <div key={k} className="grid grid-cols-[7rem_1fr] gap-2 text-[13px]"><span className="truncate text-faint">{k}</span><span className="break-words">{v}</span></div>)}</Section>
          </div>
        </DialogContent>)}</Dialog>
    </div>
  );
}
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => { const kids = Array.isArray(children) ? children : [children]; if (!kids.filter(Boolean).length) return null; return <div><h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-faint">{title}</h4><div className="space-y-1.5">{children}</div></div>; };

/* ------------------------------ Stack ------------------------------ */
export function StackTab({ inv }: { inv: Investigation }) {
  const groups = useMemo(() => { const m = new Map<string, Investigation["technologies"]>(); for (const t of inv.technologies) m.set(t.category, [...(m.get(t.category) ?? []), t]); return [...m.entries()].sort((a, b) => b[1].length - a[1].length); }, [inv.technologies]);
  const dt = inv.designTokens;
  return (
    <div className="space-y-5">
      {groups.length === 0 ? <EmptyState title="No technologies detected" body="Nothing matched the fingerprint rules with enough confidence. That does not prove nothing is there — see the limits on the Overview tab." /> :
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{groups.map(([cat, ts]) => <Card key={cat}><CardHeader><CardTitle>{cat}</CardTitle><span className="text-xs text-faint">{ts.length}</span></CardHeader><ul className="divide-y divide-line">{ts.sort((a, b) => b.confidence - a.confidence).map((t) => <li key={t.name} className="space-y-1.5 px-4 py-2.5"><div className="flex items-center justify-between gap-2"><span className="truncate text-[13px] font-medium">{t.name}{t.version && <span className="ml-1.5 text-xs font-normal text-muted">{t.version}</span>}</span><ConfidenceBar value={t.confidence} /></div><EvidenceChips ids={t.evidence} max={4} /></li>)}</ul></Card>)}</div>}
      <div className="grid gap-4 lg:grid-cols-2">
        {inv.thirdParties && inv.thirdParties.length > 0 && <Card><CardHeader><CardTitle>Third-party hosts</CardTitle></CardHeader><ul className="divide-y divide-line">{inv.thirdParties.slice(0, 30).map((t) => <li key={t.host} className="flex items-center justify-between gap-3 px-4 py-2 text-[13px]"><span className="truncate font-mono text-xs">{t.host}</span><span className="flex shrink-0 gap-1.5">{t.kinds.slice(0, 3).map((k) => <Badge key={k}>{k}</Badge>)}<span className="text-xs text-faint">×{t.count}</span></span></li>)}</ul></Card>}
        {dt && (dt.colors.length > 0 || dt.fonts.length > 0) && <Card><CardHeader><CardTitle>Design tokens</CardTitle></CardHeader><CardBody className="space-y-4">
          {dt.colors.length > 0 && <div><div className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">Colors by usage</div><div className="flex flex-wrap gap-2">{dt.colors.slice(0, 24).map((c) => <button key={c.value} onClick={() => navigator.clipboard?.writeText(c.value).then(() => toast.success(`Copied ${c.value}`))} className="group flex items-center gap-2 rounded-lg border border-line px-2 py-1 text-xs transition hover:border-line-strong" title={`${c.count} uses — click to copy`}><span className="size-4 rounded border border-line-strong" style={{ background: c.value }} /><span className="font-mono">{c.value}</span></button>)}</div></div>}
          {dt.fonts.length > 0 && <div><div className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">Fonts</div><div className="flex flex-wrap gap-1.5">{dt.fonts.slice(0, 12).map((f) => <Badge key={f.value}>{f.value}</Badge>)}</div></div>}
          {Object.keys(dt.variables).length > 0 && <div><div className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">CSS variables ({Object.keys(dt.variables).length})</div><div className="max-h-40 overflow-auto rounded-lg border border-line bg-bg p-2 font-mono text-xs">{Object.entries(dt.variables).slice(0, 80).map(([k, v]) => <div key={k} className="flex gap-2"><span className="text-accent">{k}</span><span className="truncate text-muted">{v}</span></div>)}</div></div>}
        </CardBody></Card>}
        {inv.routes && inv.routes.length > 0 && <Card><CardHeader><CardTitle>Routes</CardTitle><span className="text-xs text-faint">{inv.routes.length}</span></CardHeader><ul className="max-h-80 divide-y divide-line overflow-auto">{inv.routes.slice(0, 120).map((r, i) => <li key={i} className="flex items-center justify-between gap-3 px-4 py-1.5 text-[13px]"><span className="truncate font-mono text-xs">{r.route}</span><Badge>{r.via}</Badge></li>)}</ul></Card>}
        {inv.components && inv.components.length > 0 && <Card><CardHeader><CardTitle>Components</CardTitle><span className="text-xs text-faint">{inv.components.length}</span></CardHeader><ul className="max-h-80 divide-y divide-line overflow-auto">{inv.components.slice(0, 150).map((c, i) => <li key={i} className="flex items-center justify-between gap-3 px-4 py-1.5 text-[13px]"><span className="truncate font-mono text-xs">{c.name}</span><KindBadge kind={c.provenance} /></li>)}</ul></Card>}
        {inv.envVars && inv.envVars.length > 0 && <Card><CardHeader><CardTitle>Environment variables (names only)</CardTitle></CardHeader><ul className="max-h-60 divide-y divide-line overflow-auto">{inv.envVars.map((e) => <li key={e.name} className="flex items-center justify-between gap-3 px-4 py-1.5 text-[13px]"><span className="font-mono text-xs">{e.name}</span><span className="truncate text-xs text-faint">{e.files.slice(0, 2).join(", ")}</span></li>)}</ul></Card>}
      </div>
    </div>
  );
}

/* ------------------------------ Features ------------------------------ */
export function FeatureDialog({ inv, f, onClose }: { inv: Investigation; f: Feature | null; onClose: () => void }) {
  const nav = useNavigate(); const { project, mutate } = useApp();
  const key = f ? `${inv.id}:${f.id}` : ""; const pinned = !!project?.featureLibrary.includes(key);
  return (
    <Dialog open={!!f} onOpenChange={(o) => !o && onClose()}>{f && (
      <DialogContent side="right" title={f.name} description={f.category}>
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-2"><KindBadge kind={f.provenance} /><ConfidenceBar value={f.confidence} /></div>
          <p className="leading-relaxed">{f.description}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<Hammer className="size-4" />} onClick={() => nav(`/studio?inv=${inv.id}&feature=${f.id}&tab=extract`)}>Recreate this feature</Button>
            <Button variant="secondary" icon={pinned ? <BookmarkCheck className="size-4 text-ok" /> : <BookmarkPlus className="size-4" />} onClick={() => { mutate((p) => ({ ...p, featureLibrary: pinned ? p.featureLibrary.filter((k) => k !== key) : [...p.featureLibrary, key] })); toast.success(pinned ? "Removed from library" : "Saved to Feature Library"); }}>{pinned ? "In library" : "Save to library"}</Button>
          </div>
          <Section title="Behaviour spec (inferred from evidence)">
            {([["Purpose", [f.spec.purpose]], ["Inputs", f.spec.inputs], ["Outputs", f.spec.outputs], ["States", f.spec.states], ["Transitions", f.spec.transitions], ["Dependencies", f.spec.dependencies], ["Error states", f.spec.errorStates], ["Accessibility", f.spec.accessibility], ["Hypotheses (unverified)", f.spec.hypotheses]] as [string, string[]][]).filter(([, v]) => v.filter(Boolean).length).map(([k, v]) => <div key={k}><div className="text-xs font-medium text-faint">{k}</div><ul className="list-disc pl-5 text-[13px] text-muted">{v.filter(Boolean).slice(0, 12).map((x, i) => <li key={i} className="break-words">{x}</li>)}</ul></div>)}
          </Section>
          <Section title="Evidence"><EvidenceChips ids={f.evidence} max={12} /></Section>
          {f.pages.length > 0 && <Section title="Pages">{f.pages.slice(0, 8).map((id) => { const p = inv.pages.find((x) => x.id === id); return p ? <div key={id} className="truncate font-mono text-xs text-muted">{pathOf(p.url)}</div> : null; })}</Section>}
          {f.files.length > 0 && <Section title="Files">{f.files.slice(0, 8).map((p) => <div key={p} className="truncate font-mono text-xs text-muted">{p}</div>)}</Section>}
        </div>
      </DialogContent>)}</Dialog>
  );
}
export function FeaturesTab({ inv }: { inv: Investigation }) {
  const [q, setQ] = useState(""); const [sel, setSel] = useState<Feature | null>(null);
  const cats = useMemo(() => [...new Set(inv.features.map((f) => f.category))], [inv.features]); const [cat, setCat] = useState("all");
  const rows = inv.features.filter((f) => (cat === "all" || f.category === cat) && (!q || (f.name + f.description).toLowerCase().includes(q.toLowerCase())));
  if (!inv.features.length) return <EmptyState title="No features inferred" body="The feature inventory is built only from observed evidence (forms, routes, APIs, components). None met that bar." />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3"><Filter value={q} onChange={setQ} placeholder="Filter features…" /><Segmented size="sm" value={cat} onChange={setCat} options={[{ value: "all", label: "All" }, ...cats.slice(0, 6).map((c) => ({ value: c, label: c }))]} className="max-w-full overflow-x-auto" /></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{rows.map((f) => <Card key={f.id} interactive onClick={() => setSel(f)} className="space-y-2.5 p-4"><div className="flex items-start justify-between gap-2"><h3 className="text-sm font-semibold">{f.name}</h3><KindBadge kind={f.provenance} /></div><p className="line-clamp-3 text-[13px] text-muted">{f.description}</p><div className="flex items-center justify-between"><Badge>{f.category}</Badge><ConfidenceBar value={f.confidence} /></div></Card>)}</div>
      <FeatureDialog inv={inv} f={sel} onClose={() => setSel(null)} />
    </div>
  );
}

/* ------------------------------ Files ------------------------------ */
const PROV: Record<SourceFile["provenance"], "ok" | "accent" | "info" | "warn"> = { recovered: "ok", reconstructed: "accent", user: "info", generated: "warn" };
export function FilesTab({ inv }: { inv: Investigation }) {
  const [q, setQ] = useState(""); const [n, setN] = useState(150); const [sel, setSel] = useState<SourceFile | null>(null);
  const { mutate } = useApp(); const nav = useNavigate();
  const rows = useMemo(() => inv.files.filter((f) => !q || f.path.toLowerCase().includes(q.toLowerCase())), [inv.files, q]);
  if (!inv.files.length) return <EmptyState icon={<FileCode2 className="size-5" />} title="No source files" body="Websites only expose source when a public source map ships with the bundle. None was found here — see the limits on the Overview tab." />;
  const toWorkspace = () => { const withContent = inv.files.filter((f) => f.content !== undefined); mutate((p) => ({ ...p, workspace: { ...p.workspace, files: { ...p.workspace.files, ...Object.fromEntries(withContent.map((f) => [`reference/${inv.name.replace(/[^\w.-]+/g, "_")}/${f.path}`, f.content!])) } } })); toast.success(`${withContent.length} files copied to the workspace under reference/`); nav("/workspace"); };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3"><Filter value={q} onChange={setQ} placeholder="Filter files…" /><div className="flex items-center gap-2"><span className="text-xs text-muted">{rows.length} of {inv.files.length}</span><Button size="sm" variant="secondary" onClick={toWorkspace}>Copy to workspace</Button></div></div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,22rem)_1fr]">
        <Card className="max-h-[65dvh] overflow-auto"><ul className="divide-y divide-line">{rows.slice(0, n).map((f) => <li key={f.path}><button onClick={() => setSel(f)} className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition hover:bg-elevated", sel?.path === f.path && "bg-accent-soft")}><FileCode2 className="size-4 shrink-0 text-muted" /><span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>{f.path}</span><Badge tone={PROV[f.provenance]}>{f.provenance}</Badge></button></li>)}</ul><More n={n} total={rows.length} onMore={() => setN(n + 150)} /></Card>
        <Card className="min-h-64 overflow-hidden">{!sel ? <EmptyState title="Select a file" body="Recovered files are exact originals from public source maps; reconstructed files are rebuilt and may differ from the author's source." /> : <>
          <CardHeader><div className="min-w-0"><div className="truncate font-mono text-xs">{sel.path}</div><div className="mt-1 flex flex-wrap gap-2 text-xs text-muted"><Badge tone={PROV[sel.provenance]}>{sel.provenance}</Badge>{sel.redacted?.length ? <Badge tone="warn" title="Secret-shaped values are never stored">{sel.redacted[0] === "har-capture-not-stored" ? "capture not stored" : `redacted: ${sel.redacted.join(", ")}`}</Badge> : null}<span>{sel.language}</span><span>{fmtNum(sel.lines)} lines</span><span>{fmtBytes(sel.bytes)}</span></div></div>{sel.content !== undefined && <Button size="xs" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => navigator.clipboard?.writeText(sel.content!).then(() => toast.success("Copied"))}>Copy</Button>}</CardHeader>
          {sel.content === undefined ? <p className="p-4 text-[13px] text-muted">{sel.redacted?.[0] === "har-capture-not-stored" ? "HAR captures contain cookies, tokens and bodies, so the file is analysed but never stored. " : "Content isn't stored (binary or very large). "}SHA-256 {sel.hash}</p> : <pre className="max-h-[60dvh] overflow-auto p-4 font-mono text-xs leading-relaxed"><code>{sel.content.length > 200_000 ? sel.content.slice(0, 200_000) + "\n… (preview truncated; copy to workspace for the full file)" : sel.content}</code></pre>}
          <div className="border-t border-line px-4 py-2 text-[11px] text-faint">Origin: {sel.origin}</div></>}</Card>
      </div>
    </div>
  );
}

/* ------------------------------ Dependencies ------------------------------ */
export function DepsTab({ inv }: { inv: Investigation }) {
  const { saveInvestigation, settings } = useApp();
  const [q, setQ] = useState(""); const [eco, setEco] = useState("all"); const [n, setN] = useState(150); const [busy, setBusy] = useState(false);
  const ecos = [...new Set(inv.dependencies.map((d) => d.ecosystem))];
  const vuln = useMemo(() => new Map((inv.vulnerabilities?.items ?? []).map((v) => [`${v.ecosystem}:${v.package}@${v.version}`, v])), [inv.vulnerabilities]);
  const rows = inv.dependencies.filter((d) => (eco === "all" || d.ecosystem === eco) && (!q || d.name.toLowerCase().includes(q.toLowerCase())));
  const check = async () => { setBusy(true); try { const next = await runVulnerabilityCheck(inv); saveInvestigation(next); const c = next.vulnerabilities!; toast[c.items.length ? "warning" : "success"](c.items.length ? `${c.items.length} vulnerable dependenc${c.items.length === 1 ? "y" : "ies"} found` : `No known vulnerabilities in ${c.checked} checked dependencies`); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  if (!inv.dependencies.length) return <EmptyState title="No dependencies recorded" body="Manifests and lockfiles weren't available. For websites, only CDN-hosted libraries with versions in their URLs are listed." />;
  const v = inv.vulnerabilities;
  return (
    <div className="space-y-3">
      <Card className="flex flex-wrap items-center gap-3 p-3">
        <ShieldAlert className={cn("size-5", v ? (v.items.length ? "text-bad" : "text-ok") : "text-muted")} />
        <div className="min-w-0 flex-1 text-[13px]">{v ? <><span className="font-medium">{v.items.length ? `${v.items.length} vulnerable` : "No known vulnerabilities"}</span> <span className="text-muted">— {v.checked} exact-version dependencies checked against OSV.dev {ago(v.checkedAt)}{v.skipped ? `; ${v.skipped} with version ranges skipped (a range doesn't say what's installed)` : ""}.</span></> : <span className="text-muted">Check exact-version dependencies against the OSV.dev vulnerability database. This sends package names and versions to api.osv.dev, so it only runs when you ask.</span>}</div>
        <Button size="sm" variant={v ? "secondary" : "primary"} loading={busy} disabled={settings.localOnly} title={settings.localOnly ? "Disabled in local-only mode" : undefined} onClick={check}>{v ? "Re-check" : "Check vulnerabilities"}</Button>
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-3"><Filter value={q} onChange={setQ} placeholder="Filter dependencies…" /><Segmented size="sm" value={eco} onChange={setEco} options={[{ value: "all", label: `All ${inv.dependencies.length}` }, ...ecos.map((e) => ({ value: e, label: e }))]} className="max-w-full overflow-x-auto" /></div>
      <Card className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-[13px]"><thead className="border-b border-line text-left text-xs text-faint"><tr><th className="px-4 py-2 font-medium">Package</th><th className="px-2 py-2 font-medium">Version</th><th className="px-2 py-2 font-medium">Ecosystem</th><th className="hidden px-2 py-2 font-medium md:table-cell">Declared in</th><th className="px-2 py-2 font-medium">Security</th></tr></thead><tbody className="divide-y divide-line">{rows.slice(0, n).map((d, i) => { const x = vuln.get(`${d.ecosystem}:${d.name}@${d.version}`); return <tr key={i}><td className="px-4 py-1.5 font-mono text-xs">{d.name}{d.dev && <Badge className="ml-2">dev</Badge>}</td><td className="px-2 py-1.5 font-mono text-xs text-muted">{d.version ?? "—"}</td><td className="px-2 py-1.5"><Badge>{d.ecosystem}</Badge></td><td className="hidden max-w-[16rem] truncate px-2 py-1.5 text-xs text-faint md:table-cell">{d.source}</td><td className="px-2 py-1.5">{x ? <Badge tone={x.severity === "critical" || x.severity === "high" ? "bad" : "warn"} title={`${x.summary} (${x.ids.join(", ")})${x.fixed?.length ? ` — fixed in ${x.fixed.join(", ")}` : ""}`}>{x.severity} · {x.ids[0]}</Badge> : <span className="text-xs text-faint">{v ? "—" : ""}</span>}</td></tr>; })}</tbody></table></div><More n={n} total={rows.length} onMore={() => setN(n + 150)} /></Card>
    </div>
  );
}

/* ------------------------------ APIs ------------------------------ */
export function ApisTab({ inv }: { inv: Investigation }) {
  const [n, setN] = useState(100);
  if (!inv.endpoints.length) return <EmptyState title="No API endpoints found" body="Static analysis found no fetch/XHR/WebSocket targets. Apps that build URLs at runtime need the desktop app's rendered mode to observe them." />;
  return (
    <Card className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-[13px]"><thead className="border-b border-line text-left text-xs text-faint"><tr><th className="px-4 py-2 font-medium">Kind</th><th className="px-2 py-2 font-medium">Method</th><th className="px-2 py-2 font-medium">URL</th><th className="hidden px-2 py-2 font-medium md:table-cell">Found in</th><th className="px-2" /></tr></thead><tbody className="divide-y divide-line">{inv.endpoints.slice(0, n).map((e, i) => <tr key={i}><td className="px-4 py-1.5"><Badge tone={e.kind === "graphql" ? "accent" : e.kind === "websocket" ? "teal" : "neutral"}>{e.kind}</Badge></td><td className="px-2 py-1.5 font-mono text-xs">{e.method ?? "?"}</td><td className="max-w-[22rem] truncate px-2 py-1.5 font-mono text-xs" title={e.url}>{e.url}</td><td className="hidden max-w-[14rem] truncate px-2 py-1.5 text-xs text-faint md:table-cell">{pathOf(e.foundIn)}</td><td className="px-2"><EvidenceChips ids={[e.evidence]} /></td></tr>)}</tbody></table></div><More n={n} total={inv.endpoints.length} onMore={() => setN(n + 100)} /></Card>
  );
}

/* ------------------------------ Findings ------------------------------ */
export function FindingsTab({ inv }: { inv: Investigation }) {
  const areas = [...new Set(inv.findings.map((f) => f.area))]; const [area, setArea] = useState("all");
  const rank = (s: string) => ["high", "medium", "low", "info"].indexOf(s);
  const rows = inv.findings.filter((f) => area === "all" || f.area === area).sort((a, b) => rank(a.severity) - rank(b.severity));
  if (!inv.findings.length) return <EmptyState title="No findings" body="The checks that ran flagged nothing. Check the Overview tab for which checks ran and which were skipped." />;
  return (
    <div className="space-y-3">
      <Segmented size="sm" value={area} onChange={setArea} options={[{ value: "all", label: `All ${inv.findings.length}` }, ...areas.map((a) => ({ value: a, label: `${a} ${inv.findings.filter((f) => f.area === a).length}` }))]} className="max-w-full overflow-x-auto" />
      <div className="space-y-2">{rows.map((f) => <Card key={f.id} className="space-y-1.5 p-4"><div className="flex flex-wrap items-center gap-2"><Badge tone={SEV[f.severity]}>{f.severity}</Badge><Badge>{f.area}</Badge><h3 className="text-sm font-medium">{f.title}</h3></div><p className="text-[13px] leading-relaxed text-muted">{f.detail}</p><EvidenceChips ids={f.evidence} max={6} /></Card>)}</div>
    </div>
  );
}

/* ------------------------------ Evidence ledger ------------------------------ */
export function EvidenceTab({ inv }: { inv: Investigation }) {
  const { open } = useEvidence(); const [q, setQ] = useState(""); const [kind, setKind] = useState("all"); const [n, setN] = useState(100);
  const kinds = [...new Set(inv.evidence.map((e) => e.kind))];
  const rows = useMemo(() => inv.evidence.filter((e) => (kind === "all" || e.kind === kind) && (!q || (e.summary + e.source + e.method).toLowerCase().includes(q.toLowerCase()))), [inv.evidence, q, kind]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3"><Filter value={q} onChange={setQ} placeholder="Search evidence…" /><Segmented size="sm" value={kind} onChange={setKind} options={[{ value: "all", label: `All ${inv.evidence.length}` }, ...kinds.map((k) => ({ value: k, label: `${k} ${inv.evidence.filter((e) => e.kind === k).length}` }))]} className="max-w-full overflow-x-auto" /></div>
      <Card className="overflow-hidden"><ul className="divide-y divide-line">{rows.slice(0, n).map((e) => <li key={e.id}><button onClick={() => open(e.id)} className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition hover:bg-elevated"><KindBadge kind={e.kind} /><div className="min-w-0 flex-1"><div className="truncate text-[13px]">{e.summary}</div><div className="truncate font-mono text-[11px] text-faint">{e.method} · {e.source || e.id}</div></div><span className="hidden text-xs tabular-nums text-muted sm:block">{Math.round(e.confidence * 100)}%</span></button></li>)}</ul><More n={n} total={rows.length} onMore={() => setN(n + 100)} /></Card>
    </div>
  );
}
