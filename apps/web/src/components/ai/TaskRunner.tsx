import { useState } from "react";
import { Ban, CheckCircle2, ChevronDown, CircleDashed, CircleX, Loader2, Lock, Pencil, Play, SkipForward, Square, Undo2 } from "lucide-react";
import { ROLES, type AgentTask } from "@omniforge/core";
import { cn } from "@/lib/utils";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Progress, Textarea } from "@/components/ui/primitives";

const ICON: Record<AgentTask["status"], React.ReactNode> = {
  pending: <CircleDashed className="size-4 text-faint" />, running: <Loader2 className="size-4 animate-spin text-info" />, done: <CheckCircle2 className="size-4 text-ok" />,
  failed: <CircleX className="size-4 text-bad" />, blocked: <Lock className="size-4 text-warn" />, skipped: <SkipForward className="size-4 text-faint" />,
};

/**
 * Visual task graph: every task shows its objective, role, model and verifiable acceptance checks.
 * The user can edit an objective, skip a task, and run/stop. Failed acceptance checks are shown, never hidden.
 */
export function TaskRunner({ tasks, setTasks, running, onRun, onStop, skip, setSkip, title = "Plan", disabledReason, runLabel = "Run plan" }: {
  tasks: AgentTask[]; setTasks: (t: AgentTask[]) => void; running: boolean; onRun: () => void; onStop: () => void; skip: Set<string>; setSkip: (s: Set<string>) => void; title?: string; disabledReason?: string; runLabel?: string;
}) {
  const [open, setOpen] = useState<string | null>(null); const [edit, setEdit] = useState<string | null>(null);
  const done = tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
  const failed = tasks.filter((t) => t.status === "failed" || t.status === "blocked").length;
  const patch = (id: string, p: Partial<AgentTask>) => setTasks(tasks.map((t) => (t.id === id ? { ...t, ...p } : t)));
  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3"><CardTitle>{title}</CardTitle><span className="text-xs text-muted">{done}/{tasks.length} done{failed ? ` · ${failed} need attention` : ""}</span></div>
        {running ? <Button size="sm" variant="danger" icon={<Square className="size-3.5" />} onClick={onStop}>Stop</Button> : <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} onClick={onRun} disabled={!!disabledReason || tasks.length === 0} title={disabledReason}>{tasks.some((t) => t.status === "failed" || t.status === "blocked") ? "Resume" : runLabel}</Button>}
      </CardHeader>
      {(running || done > 0) && <div className="px-4 pt-3"><Progress value={tasks.length ? done / tasks.length : 0} tone={failed ? "warn" : "accent"} /></div>}
      {disabledReason && !running && <p className="px-4 pt-3 text-xs text-warn">{disabledReason}</p>}
      <ul className="divide-y divide-line">
        {tasks.map((t, i) => {
          const skipped = skip.has(t.id); const isOpen = open === t.id; const status = skipped && t.status === "pending" ? "skipped" : t.status;
          return (
            <li key={t.id}>
              <div className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 w-4 shrink-0 text-center text-[11px] tabular-nums text-faint">{i + 1}</span>
                <span className="mt-0.5 shrink-0">{ICON[status]}</span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  {edit === t.id ? <div className="space-y-2"><Textarea value={t.objective} onChange={(e) => patch(t.id, { objective: e.target.value })} rows={3} autoFocus /><Button size="xs" variant="soft" onClick={() => setEdit(null)}>Done</Button></div>
                    : <button className={cn("block w-full text-left text-[13px] leading-snug", skipped && "text-faint line-through")} onClick={() => setOpen(isOpen ? null : t.id)}>{t.objective}</button>}
                  <div className="flex flex-wrap items-center gap-1.5"><Badge tone="accent">{ROLES[t.role]?.label ?? t.role}</Badge>{t.model && <Badge title={t.provider}>{t.model}</Badge>}{t.dependsOn.length > 0 && <span className="text-[11px] text-faint">after {t.dependsOn.map((d) => tasks.findIndex((x) => x.id === d) + 1).filter((n) => n > 0).join(", ")}</span>}{t.tests?.map((x) => <Badge key={x.name} tone={x.pass ? "ok" : "bad"} title={x.detail}>{x.name}</Badge>)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {!running && t.status === "pending" && <><Button size="icon-sm" variant="ghost" aria-label="Edit objective" title="Edit objective" onClick={() => setEdit(edit === t.id ? null : t.id)}><Pencil className="size-3.5" /></Button><Button size="icon-sm" variant="ghost" aria-label={skipped ? "Include" : "Skip"} title={skipped ? "Include this task" : "Skip this task"} onClick={() => { const n = new Set(skip); skipped ? n.delete(t.id) : n.add(t.id); setSkip(n); }}>{skipped ? <Undo2 className="size-3.5" /> : <Ban className="size-3.5" />}</Button></>}
                  {(t.status === "failed" || t.status === "blocked") && !running && <Button size="icon-sm" variant="ghost" aria-label="Retry task" title="Reset to run again" onClick={() => patch(t.id, { status: "pending", logs: [], output: undefined, tests: undefined })}><Undo2 className="size-3.5" /></Button>}
                  <Button size="icon-sm" variant="ghost" aria-label="Details" onClick={() => setOpen(isOpen ? null : t.id)}><ChevronDown className={cn("size-4 transition", isOpen && "rotate-180")} /></Button>
                </div>
              </div>
              {isOpen && (
                <CardBody className="space-y-3 border-t border-line bg-bg/50 pt-3 text-[13px]">
                  {t.acceptance.length > 0 && <div><div className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Acceptance checks</div><ul className="space-y-1 font-mono text-xs text-muted">{t.acceptance.map((a) => { const r = t.tests?.find((x) => x.name === a); return <li key={a} className="flex items-center gap-2">{r ? (r.pass ? <CheckCircle2 className="size-3.5 text-ok" /> : <CircleX className="size-3.5 text-bad" />) : <CircleDashed className="size-3.5 text-faint" />}{a}{r && !r.pass && r.detail && <span className="text-bad">— {r.detail.slice(0, 160)}</span>}</li>; })}</ul></div>}
                  {t.files && t.files.length > 0 && <div><div className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Files written</div><div className="flex flex-wrap gap-1.5">{t.files.slice(0, 30).map((f) => <Badge key={f}>{f}</Badge>)}</div></div>}
                  {t.output && <div><div className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Summary</div><p className="whitespace-pre-wrap leading-relaxed text-muted">{t.output.slice(0, 3000)}</p></div>}
                  {t.logs.length > 0 && <div><div className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Log</div><pre className="max-h-48 overflow-auto rounded-lg border border-line bg-bg p-2 font-mono text-[11px] leading-relaxed text-muted">{t.logs.slice(-60).join("\n")}</pre></div>}
                </CardBody>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
