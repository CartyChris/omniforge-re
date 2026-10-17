import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { ArrowRight, Hammer, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { DEV_MODES, REBUILD_MODES, STACKS, buildDevPlan, buildFeatureExtractionPlan, buildRebuildPlan, type AgentTask, type DevMode, type Investigation, type RebuildMode } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { runPlan } from "@/lib/ai";
import { openLocalWorkspace, type LocalWorkspace } from "@/lib/localfs";
import { listRoots, type RootInfo } from "@/lib/local";
import { cn } from "@/lib/utils";
import { Button, Card, CardBody, CardHeader, CardTitle, Field, Input, Segmented, Textarea } from "@/components/ui/primitives";
import { Select } from "@/components/ui/overlay";
import { TaskRunner } from "./TaskRunner";

type Kind = "dev" | "rebuild" | "extract";
const stackOptions = STACKS.map((s) => ({ value: s.id, label: s.label, hint: s.kind }));

export function BuildPanel() {
  const [params] = useSearchParams(); const nav = useNavigate();
  const { project, models, settings, bridge, bridgeState, newProject } = useApp();
  const invs = ((project?.investigations ?? []) as unknown as Investigation[]).filter((i) => i.status === "done" || i.features.length > 0);
  const initialKind = (params.get("tab") === "extract" ? "extract" : params.get("tab") === "rebuild" ? "rebuild" : params.get("inv") ? "rebuild" : "dev") as Kind;
  const [kind, setKind] = useState<Kind>(initialKind);
  const [invId, setInvId] = useState(params.get("inv") ?? invs[0]?.id ?? "");
  const inv = invs.find((i) => i.id === invId);
  const [featureId, setFeatureId] = useState(params.get("feature") ?? "");
  const [featureIds, setFeatureIds] = useState<string[]>(params.get("feature") ? [params.get("feature")!] : []);
  const [rebuildMode, setRebuildMode] = useState<RebuildMode>(params.get("feature") ? "feature-only" : "functional");
  const [devMode, setDevMode] = useState<DevMode>("scratch");
  const [stackId, setStackId] = useState(settings.defaultStack || "react-vite"); const [targetStackId, setTargetStackId] = useState("nextjs");
  const [prompt, setPrompt] = useState(""); const [note, setNote] = useState(""); const [improvements, setImprovements] = useState(""); const [request, setRequest] = useState<"extract" | "improve" | "adapt" | "implement-existing">("extract");
  const [where, setWhere] = useState<"browser" | "local">("browser"); const [roots, setRoots] = useState<RootInfo[]>([]); const [rootId, setRootId] = useState("");
  const [fresh, setFresh] = useState(true);
  const [tasks, setTasks] = useState<AgentTask[]>([]); const [skip, setSkip] = useState<Set<string>>(new Set()); const [running, setRunning] = useState(false); const [loading, setLoading] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null); const created = useRef(false); const local = useRef<LocalWorkspace | null>(null);
  const desktop = bridgeState === "connected" && !!bridge && bridge.conn.kind === "ui";
  useEffect(() => { if (inv && !featureId) setFeatureId(inv.features[0]?.id ?? ""); }, [inv, featureId]);
  useEffect(() => { if (desktop) void listRoots().then((r) => { const w = r.filter((x) => x.writable); setRoots(w); if (w[0] && !rootId) setRootId(w[0].id); }).catch(() => {}); }, [desktop]); // eslint-disable-line react-hooks/exhaustive-deps

  const needsInv = kind === "extract" || (kind === "rebuild") || (kind === "dev" && (devMode === "reference" || devMode === "extract"));
  const files = Object.keys(project?.workspace.files ?? {});
  const hasRunner = where === "local" && !!rootId;
  const invalid = needsInv && !inv ? "Run an analysis first — this mode builds from an investigation." : kind === "dev" && !prompt.trim() && !["reference", "extract"].includes(devMode) ? "Describe what you want." : kind === "extract" && !featureId ? "Choose a feature." : stackId === "any" && !note.trim() && !prompt.trim() ? "Describe the target stack." : "";

  const generate = () => {
    try {
      let plan: AgentTask[];
      const ctxFiles = files;
      if (kind === "rebuild") plan = buildRebuildPlan({ inv: inv!, mode: rebuildMode, stackId, stackNote: note || undefined, featureIds: ["feature-only", "synthesis"].includes(rebuildMode) ? featureIds : undefined, improvements: rebuildMode === "enhanced" ? improvements : undefined });
      else if (kind === "extract") plan = buildFeatureExtractionPlan({ inv: inv!, featureId, destStack: stackId, destFiles: ctxFiles, request, note: note || undefined });
      else plan = buildDevPlan(devMode, { prompt: prompt + (note ? `\n${note}` : ""), stackId, files: ctxFiles, inv, targetStackId });
      // The browser can't run commands: keep the checks visible instead of failing the whole plan on a check that can never run.
      if (!hasRunner) plan = plan.map((t) => ({ ...t, acceptance: t.acceptance.filter((a) => !a.startsWith("run:")) }));
      setTasks(plan); setSkip(new Set()); created.current = false;
    } catch (e) { toast.error((e as Error).message); }
  };

  const run = async () => {
    const ctrl = new AbortController(); abort.current = ctrl; setRunning(true);
    try {
      if (where === "browser" && fresh && !created.current) { await newProject(inv ? `${inv.name} → ${stackId}` : prompt.trim().slice(0, 40) || "New app"); created.current = true; }
      if (where === "local" && !local.current) { setLoading("Reading folder…"); local.current = await openLocalWorkspace(rootId); setLoading(null); }
      const brief = kind === "dev" ? prompt : `${kind === "rebuild" ? REBUILD_MODES.find((m) => m.id === rebuildMode)?.label : "Feature extraction"} of ${inv?.name ?? "the analysed app"}`;
      const done = await runPlan(tasks, { onUpdate: setTasks, signal: ctrl.signal, skip, local: local.current ?? undefined, brief });
      setTasks(done);
      const bad = done.filter((t) => t.status === "failed" || t.status === "blocked").length;
      if (bad) toast.warning(`${bad} task(s) need attention — expand them to see the failing check.`); else toast.success(where === "local" ? "Done — files were written to your folder." : "Done — the code is in your workspace.");
    } catch (e) { if ((e as Error).name !== "AbortError") toast.error((e as Error).message); } finally { setRunning(false); setLoading(null); abort.current = null; }
  };
  const finished = tasks.length > 0 && !running && tasks.some((t) => t.status === "done");
  const disabledReason = !models.length ? "Connect an AI model (Providers tab, or a local model) to run plans." : settings.localOnly && !models.some((m) => m.local) ? "Local-only mode is on and no local model is available." : undefined;
  const featOpts = (inv?.features ?? []).map((f) => ({ value: f.id, label: f.name, hint: f.category }));

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><div className="flex items-center gap-3"><CardTitle>What do you want to build?</CardTitle></div><Segmented size="sm" value={kind} onChange={(k) => { setKind(k); setTasks([]); }} options={[{ value: "dev", label: "From a prompt / project" }, { value: "rebuild", label: "Rebuild an analysed app" }, { value: "extract", label: "Extract a feature" }]} /></CardHeader>
        <CardBody className="space-y-5">
          {kind === "dev" && <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup" aria-label="Development mode">{DEV_MODES.map((m) => <button key={m.id} role="radio" aria-checked={devMode === m.id} onClick={() => { setDevMode(m.id); setTasks([]); }} className={cn("space-y-1 rounded-xl border p-3 text-left transition", devMode === m.id ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong hover:bg-elevated")}><div className="flex items-center gap-2 text-[13px] font-semibold"><span className="grid size-5 place-items-center rounded-md bg-overlay text-[11px]">{m.letter}</span>{m.label}</div><p className="text-xs text-muted">{m.blurb}</p></button>)}</div>}
          {kind === "rebuild" && <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup" aria-label="Rebuild mode">{REBUILD_MODES.map((m) => <button key={m.id} role="radio" aria-checked={rebuildMode === m.id} onClick={() => { setRebuildMode(m.id); setTasks([]); }} className={cn("space-y-1 rounded-xl border p-3 text-left transition", rebuildMode === m.id ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong hover:bg-elevated")}><div className="flex items-center gap-2 text-[13px] font-semibold"><span className="grid size-5 place-items-center rounded-md bg-overlay text-[11px]">{m.n}</span>{m.label}</div><p className="text-xs text-muted">{m.blurb}</p></button>)}</div>}

          <div className="grid gap-4 md:grid-cols-2">
            {needsInv && <Field label="Based on investigation" className={kind === "dev" ? "" : ""}>{invs.length ? <Select value={invId} onValueChange={(v) => { setInvId(v); setFeatureId(""); setFeatureIds([]); }} options={invs.map((i) => ({ value: i.id, label: i.name, hint: `${i.features.length} features` }))} /> : <Button variant="secondary" onClick={() => nav("/analyze")}>Analyze something first</Button>}</Field>}
            {kind === "extract" && <Field label="Feature"><Select value={featureId} onValueChange={setFeatureId} options={featOpts} placeholder="Choose a feature" /></Field>}
            {kind === "extract" && <Field label="What to do"><Select value={request} onValueChange={(v) => setRequest(v as typeof request)} options={[{ value: "extract", label: "Recreate it" }, { value: "improve", label: "Recreate and improve it" }, { value: "adapt", label: "Adapt it to the target stack" }, { value: "implement-existing", label: "Implement inside my existing app" }]} /></Field>}
            <Field label={kind === "dev" && devMode === "convert" ? "Convert from (current project) to" : "Target stack"}>{kind === "dev" && devMode === "convert" ? <Select value={targetStackId} onValueChange={setTargetStackId} options={stackOptions} /> : <Select value={stackId} onValueChange={setStackId} options={stackOptions} />}</Field>
          </div>
          {kind === "rebuild" && ["feature-only", "synthesis"].includes(rebuildMode) && inv && <div><p className="mb-2 text-xs font-medium text-muted">Features to include</p><div className="flex flex-wrap gap-2">{inv.features.map((f) => <label key={f.id} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[13px]", featureIds.includes(f.id) ? "border-accent bg-accent-soft" : "border-line")}><input type="checkbox" checked={featureIds.includes(f.id)} onChange={(e) => setFeatureIds(e.target.checked ? [...featureIds, f.id] : featureIds.filter((x) => x !== f.id))} />{f.name}</label>)}</div></div>}
          {kind === "rebuild" && rebuildMode === "enhanced" && <Field label="Improvements to add"><Textarea rows={2} value={improvements} onChange={(e) => setImprovements(e.target.value)} placeholder="e.g. add dark mode, make it accessible, add offline support" /></Field>}
          {kind === "dev" && <Field label={devMode === "scratch" || devMode === "autonomous" ? "Describe the app" : devMode === "debug" ? "What's broken?" : "Instructions"} hint={devMode === "autonomous" ? "Autonomous mode still pauses for approval before any command, and never deploys by itself." : undefined}><Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={devMode === "scratch" ? "A habit tracker with streaks, a calendar heat-map, and CSV export" : devMode === "debug" ? "npm run build fails with a type error in src/App.tsx" : "What should change?"} /></Field>}
          {kind !== "dev" && <Field label={stackId === "any" ? "Describe the target stack (required)" : "Notes (optional)"}><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. keep the same routes; use Tailwind; backend on Supabase" /></Field>}
          {stackId === "any" && kind === "dev" && <Field label="Describe the target stack"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Flutter + Firebase" /></Field>}

          <div className="grid gap-4 border-t border-line pt-4 md:grid-cols-2">
            <Field label="Where should the code go?"><Segmented size="sm" value={where} onChange={(w) => { setWhere(w); setTasks([]); }} options={[{ value: "browser", label: "This project (in browser)" }, { value: "local", label: "A folder on my Mac" }]} /></Field>
            {where === "browser" ? <label className="flex items-center gap-2 self-end pb-2 text-[13px]"><input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />Create a new project for the result</label>
              : desktop ? <Field label="Folder (approved, writable)">{roots.length ? <Select value={rootId} onValueChange={setRootId} options={roots.map((r) => ({ value: r.id, label: r.label }))} /> : <p className="text-xs text-warn">Approve a writable folder first (Analyze → On this computer).</p>}</Field>
              : <p className="self-end pb-2 text-xs text-warn">Writing to a local folder and running tests needs the desktop app.</p>}
          </div>
          {where === "browser" && <p className="flex items-start gap-2 text-xs text-muted"><TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />In the browser, agents write code but can't execute it, so build/test commands aren't run (those checks are dropped from the plan, not faked). The desktop app runs them in your folder after you approve each command.</p>}
          <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-bad">{invalid}</span><Button variant="primary" size="lg" icon={<Sparkles className="size-4" />} disabled={!!invalid || (where === "local" && !rootId)} onClick={generate}>Generate plan</Button></div>
        </CardBody>
      </Card>

      {tasks.length > 0 && <>
        <TaskRunner tasks={tasks} setTasks={setTasks} skip={skip} setSkip={setSkip} running={running} onRun={run} onStop={() => abort.current?.abort()} title="Plan — review, edit or skip tasks, then run" disabledReason={loading ?? disabledReason} />
        {finished && <Card><CardBody className="flex flex-wrap items-center gap-3"><span className="text-sm font-medium">{where === "local" ? "Written to your folder." : "Result is in your workspace."}</span><div className="ml-auto flex gap-2"><Button variant="primary" icon={<ArrowRight className="size-4" />} onClick={() => nav("/workspace")}>Open workspace</Button><Button variant="secondary" icon={<Hammer className="size-4" />} onClick={() => nav("/deployments")}>Deploy</Button></div></CardBody></Card>}
      </>}
      {loading && <p className="flex items-center gap-2 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" />{loading}</p>}
    </div>
  );
}
