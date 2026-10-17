import { useMemo } from "react";
import { Download, FileText } from "lucide-react";
import { buildSections, renderHtml, type Investigation } from "@omniforge/core";
import { EXPORTS, exportInvestigation } from "@/lib/exporter";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@/components/ui/primitives";

export function ReportTab({ inv }: { inv: Investigation }) {
  const sections = useMemo(() => buildSections(inv), [inv]);
  const html = useMemo(() => renderHtml(inv), [inv]);
  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <div className="space-y-4">
        <Card><CardHeader><CardTitle>Export</CardTitle></CardHeader><CardBody className="space-y-1.5">{EXPORTS.map((e) => <button key={e.id} onClick={() => exportInvestigation(inv, e.id)} className="flex w-full items-center gap-3 rounded-lg border border-line px-3 py-2 text-left transition hover:border-accent/50 hover:bg-elevated"><Download className="size-4 shrink-0 text-muted" /><span className="min-w-0"><span className="block text-[13px] font-medium">{e.label}</span><span className="block truncate text-[11px] text-faint">{e.hint}</span></span></button>)}</CardBody></Card>
        <Card><CardHeader><CardTitle>{sections.length} sections</CardTitle></CardHeader><ol className="max-h-72 divide-y divide-line overflow-auto text-[13px]">{sections.map((s) => <li key={s.id} className="flex gap-2 px-4 py-1.5 text-muted"><span className="w-5 shrink-0 text-right tabular-nums text-faint">{s.n}</span>{s.title}</li>)}</ol></Card>
      </div>
      <Card className="overflow-hidden"><CardHeader><CardTitle className="flex items-center gap-2"><FileText className="size-4" />Report preview</CardTitle><Button size="xs" variant="ghost" onClick={() => exportInvestigation(inv, "pdf")}>Print / PDF</Button></CardHeader>
        {/* all values are escaped by the report renderer; the sandbox (no flags) additionally forbids scripts, forms and navigation */}
        <iframe title="Report preview" sandbox="" srcDoc={html} className="h-[70dvh] w-full bg-white" /></Card>
    </div>
  );
}
