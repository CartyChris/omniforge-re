import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, ArrowRight, Ban, CheckCircle2, Loader2, RotateCcw, X } from "lucide-react";
import { useApp, type LiveJob } from "@/lib/store";
import { analyzeWebsites } from "@/lib/analyze";
import { cn, pathOf } from "@/lib/utils";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Progress, Stat } from "@/components/ui/primitives";

const KIND: Record<LiveJob["kind"], string> = { web: "Website", source: "Files", repo: "Repository", rea: "REA", folder: "Local folder", package: "Package" };
const statusTone = (s: number) => (s >= 200 && s < 300 ? "text-ok" : s >= 300 && s < 400 ? "text-info" : s >= 400 ? "text-bad" : "text-muted");

function useTick(active: boolean) { const [, set] = useState(0); useEffect(() => { if (!active) return; const t = setInterval(() => set((n) => n + 1), 1000); return () => clearInterval(t); }, [active]); }
const fmtDur = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };

export function JobView({ job }: { job: LiveJob }) {
  const { cancelJob, dismissJob } = useApp();
  const running = job.status === "running";
  useTick(running);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [job.log.length]);
  const tree = useMemo(() => [...job.pages].sort((a, b) => a.depth - b.depth).slice(0, 400), [job.pages]);
  const elapsed = (job.endedAt ?? Date.now()) - job.startedAt;
  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-2.5">
          {running ? <Loader2 className="size-4 shrink-0 animate-spin text-info" /> : job.status === "done" ? <CheckCircle2 className="size-4 shrink-0 text-ok" /> : job.status === "cancelled" ? <Ban className="size-4 shrink-0 text-muted" /> : <AlertTriangle className="size-4 shrink-0 text-bad" />}
          <CardTitle className="truncate">{job.label}</CardTitle><Badge>{KIND[job.kind]}</Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {running && <Button size="sm" variant="danger" onClick={() => cancelJob(job.id)} icon={<X className="size-3.5" />}>Cancel</Button>}
          {!running && job.kind === "web" && job.status !== "done" && <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" />} onClick={() => void analyzeWebsites(job.targets)}>Retry</Button>}
          {job.status === "done" && job.investigationId && <Link to={`/investigations/${job.investigationId}`}><Button size="sm" variant="primary" icon={<ArrowRight className="size-3.5" />}>Open results</Button></Link>}
          {!running && <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => dismissJob(job.id)}><X className="size-4" /></Button>}
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="space-y-2"><div className="flex items-center justify-between text-xs text-muted"><span>{job.stage ?? (running ? "Starting…" : job.status)}</span><span className="tabular-nums">{Math.round(job.progress * 100)}% · {fmtDur(elapsed)}</span></div><Progress value={job.progress} tone={job.status === "error" ? "bad" : job.status === "done" ? "ok" : "accent"} /></div>
        {job.error && <div role="alert" className="whitespace-pre-line rounded-lg border border-bad/30 bg-bad/10 p-3 text-[13px] text-bad">{job.error}</div>}
        <div className="grid grid-cols-3 gap-4"><Stat label="Pages" value={job.counts.pages} /><Stat label="Assets" value={job.counts.assets} /><Stat label="Evidence" value={job.counts.evidence} /></div>
        <div className="grid gap-4 lg:grid-cols-2">
          {job.kind === "web" && (
            <div className="min-w-0"><h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-faint">Discovered pages</h4>
              <div className="max-h-72 overflow-y-auto rounded-lg border border-line bg-bg">
                {tree.length === 0 ? <p className="p-3 text-[13px] text-faint">{running ? "Waiting for the first page…" : "No pages were fetched."}</p> : <ul className="divide-y divide-line/60 text-[13px]">{tree.map((p) => <li key={p.id} className="flex items-center gap-2 px-3 py-1.5" style={{ paddingLeft: 12 + Math.min(p.depth, 6) * 12 }}><span className={cn("w-8 shrink-0 text-right font-mono text-xs tabular-nums", statusTone(p.status))}>{p.status || "—"}</span><span className="min-w-0 flex-1 truncate" title={p.url}>{pathOf(p.url)}</span><span className="hidden max-w-[10rem] truncate text-xs text-faint sm:block">{p.title}</span><Badge className="shrink-0">{p.via}</Badge></li>)}</ul>}
              </div></div>
          )}
          <div className={cn("min-w-0", job.kind !== "web" && "lg:col-span-2")}><h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-faint">Log</h4>
            <div ref={logRef} className="max-h-72 min-h-24 overflow-y-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs leading-relaxed" role="log" aria-live="polite">
              {job.log.length === 0 ? <span className="text-faint">No messages yet.</span> : job.log.map((l, i) => <div key={i} className={cn(l.level === "error" ? "text-bad" : l.level === "warn" ? "text-warn" : "text-muted")}><span className="text-faint">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span> {l.msg}</div>)}
            </div></div>
        </div>
      </CardBody>
    </Card>
  );
}
