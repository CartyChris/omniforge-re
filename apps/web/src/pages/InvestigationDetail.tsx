import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, Download, Hammer, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import type { Investigation } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { analyzeWebsites } from "@/lib/analyze";
import { EXPORTS, exportInvestigation } from "@/lib/exporter";
import { ago } from "@/lib/utils";
import { Badge, Button, EmptyState } from "@/components/ui/primitives";
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSep, DropdownTrigger, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlay";
import { CoverageRing, StatusBadge } from "@/components/domain/bits";
import { EvidenceProvider } from "@/components/investigation/EvidenceLink";
import { OverviewTab } from "@/components/investigation/OverviewTab";
import { GraphTab } from "@/components/investigation/GraphTab";
import { ApisTab, DepsTab, EvidenceTab, FeaturesTab, FilesTab, FindingsTab, PagesTab, StackTab } from "@/components/investigation/DataTabs";
import { AskTab } from "@/components/investigation/AskTab";
import { ReportTab } from "@/components/investigation/ReportTab";

export default function InvestigationDetail() {
  const { id } = useParams();
  const { project, removeInvestigation } = useApp();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const inv = useMemo(() => (project?.investigations as unknown as Investigation[] | undefined)?.find((i) => i.id === id), [project, id]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tab = params.get("tab") ?? "overview";
  const setTab = (t: string) => setParams({ tab: t }, { replace: true });
  if (!inv) return <div className="mx-auto max-w-3xl p-6"><EmptyState title="Investigation not found" body="It may belong to another project, or it was deleted." action={<Link to="/investigations"><Button variant="primary">All investigations</Button></Link>} /></div>;
  const web = inv.pages.length > 0;
  const tabs: { id: string; label: string; count?: number; show?: boolean }[] = [
    { id: "overview", label: "Overview" },
    { id: "pages", label: "Pages", count: inv.pages.length, show: web },
    { id: "stack", label: "Stack", count: inv.technologies.length },
    { id: "features", label: "Features", count: inv.features.length },
    { id: "graph", label: "Graph" },
    { id: "files", label: "Files", count: inv.files.length, show: inv.files.length > 0 },
    { id: "deps", label: "Dependencies", count: inv.dependencies.length, show: inv.dependencies.length > 0 },
    { id: "apis", label: "APIs", count: inv.endpoints.length, show: inv.endpoints.length > 0 },
    { id: "findings", label: "Findings", count: inv.findings.length },
    { id: "evidence", label: "Evidence", count: inv.evidence.length },
    { id: "ask", label: "Ask AI" },
    { id: "report", label: "Report" },
  ];
  const resumable = (inv.status === "interrupted" || inv.status === "error" || inv.status === "cancelled") && inv.targets.every((t) => t.kind === "url" || t.kind === "urls");
  return (
    <EvidenceProvider inv={inv}>
      <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/investigations" className="rounded-lg p-1.5 text-muted transition hover:bg-overlay hover:text-fg" aria-label="Back to investigations"><ArrowLeft className="size-4" /></Link>
          <CoverageRing value={inv.coverage.score} size={48} />
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">{inv.name}</h1><StatusBadge s={inv.status} /></div><p className="truncate text-xs text-muted">{inv.targets.map((t) => t.value).join(" · ")} · {ago(inv.startedAt)}</p></div>
          <div className="flex items-center gap-2">
            {resumable && <Button variant="secondary" icon={<RefreshCw className="size-4" />} onClick={async () => { const j = await analyzeWebsites(inv.targets.map((t) => t.value), inv.config, { name: inv.name }); nav(`/analyze?job=${j}`); }}>Re-run</Button>}
            <Button variant="primary" icon={<Hammer className="size-4" />} onClick={() => nav(`/studio?inv=${inv.id}&tab=rebuild`)}><span className="hidden sm:inline">Rebuild</span></Button>
            <Dropdown><DropdownTrigger asChild><Button variant="secondary" icon={<Download className="size-4" />}><span className="hidden sm:inline">Export</span></Button></DropdownTrigger><DropdownContent>{EXPORTS.map((e) => <DropdownItem key={e.id} onSelect={() => exportInvestigation(inv, e.id)}><span>{e.label}<span className="block text-[11px] text-faint">{e.hint}</span></span></DropdownItem>)}</DropdownContent></Dropdown>
            <Dropdown><DropdownTrigger asChild><Button variant="ghost" size="icon" aria-label="More"><MoreHorizontal className="size-4" /></Button></DropdownTrigger><DropdownContent><DropdownLabel>Investigation</DropdownLabel><DropdownItem onSelect={() => nav("/studio?inv=" + inv.id + "&tab=extract")}>Extract features…</DropdownItem><DropdownSep /><DropdownItem danger onSelect={() => setConfirmDelete(true)}><Trash2 className="size-4" />Delete</DropdownItem></DropdownContent></Dropdown>
          </div>
        </div>
        {confirmDelete && <div role="alertdialog" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-bad/30 bg-bad/10 p-3 text-sm"><span>Delete “{inv.name}” and its evidence? Exported copies are not affected.</span><span className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button><Button size="sm" variant="danger" onClick={() => { removeInvestigation(inv.id); nav("/investigations"); }}>Delete</Button></span></div>}
        {inv.status === "interrupted" && <div className="rounded-xl border border-warn/30 bg-warn/10 p-3 text-[13px] text-warn">This analysis was interrupted (page closed or connection lost). What was captured is kept below; re-run to complete it.</div>}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="-mx-4 px-4 sm:mx-0 sm:px-0">{tabs.filter((t) => t.show !== false).map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}{t.count !== undefined && <Badge className="ml-1.5">{t.count}</Badge>}</TabsTrigger>)}</TabsList>
          <div className="pt-4">
            <TabsContent value="overview"><OverviewTab inv={inv} go={setTab} /></TabsContent>
            <TabsContent value="pages"><PagesTab inv={inv} /></TabsContent>
            <TabsContent value="stack"><StackTab inv={inv} /></TabsContent>
            <TabsContent value="features"><FeaturesTab inv={inv} /></TabsContent>
            <TabsContent value="graph"><GraphTab inv={inv} /></TabsContent>
            <TabsContent value="files"><FilesTab inv={inv} /></TabsContent>
            <TabsContent value="deps"><DepsTab inv={inv} /></TabsContent>
            <TabsContent value="apis"><ApisTab inv={inv} /></TabsContent>
            <TabsContent value="findings"><FindingsTab inv={inv} /></TabsContent>
            <TabsContent value="evidence"><EvidenceTab inv={inv} /></TabsContent>
            <TabsContent value="ask"><AskTab inv={inv} /></TabsContent>
            <TabsContent value="report"><ReportTab inv={inv} /></TabsContent>
          </div>
        </Tabs>
      </div>
    </EvidenceProvider>
  );
}
