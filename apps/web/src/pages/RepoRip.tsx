import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Boxes, Check, Copy, Download, FolderGit2, GitFork, Github, Layers, Search, ShieldAlert, ShieldCheck, Wand2, X } from "lucide-react";
import { STACKS, assessRip, buildClonePackage, buildMeshPlan, buildPortPlan, meshRepos, parseRepoList, stackById, zipPackage, RightsError, type AgentTask, type MeshReport, type RepoSnapshot } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { fetchRepoSnapshot, inspectRepos, type RepoInspect, type RepoSummary } from "@/lib/analyze";
import { runPlan } from "@/lib/ai";
import { ghToken, publishToGitHub } from "@/lib/github";
import { cn, download, fmtBytes, fmtNum } from "@/lib/utils";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Field, Input, Progress, SectionTitle, Textarea } from "@/components/ui/primitives";
import { Select, ToggleRow } from "@/components/ui/overlay";
import { TaskRunner } from "@/components/ai/TaskRunner";

type Mode = "clone" | "port" | "mesh";
const LIC_TONE = (c: string) => (c === "permissive" || c === "public-domain" ? "ok" : c.includes("copyleft") ? "warn" : "bad") as "ok" | "warn" | "bad";
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "app";

interface Output { kind: "clone" | "mesh"; files: Map<string, Uint8Array>; textFiles: Record<string, string>; notes: string[]; report?: MeshReport; name: string }

export default function RepoRip() {
  const [params] = useSearchParams(); const nav = useNavigate();
  const { models, settings, mutate, newProject } = useApp();
  const [text, setText] = useState(params.get("repos") ?? "");
  const [useToken, setUseToken] = useState(false); const [hasToken, setHasToken] = useState(false);
  const [inspect, setInspect] = useState<RepoInspect | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [attested, setAttested] = useState(false);
  const [mode, setMode] = useState<Mode>("clone");
  const [stackId, setStackId] = useState(settings.defaultStack || "react-vite"); const [note, setNote] = useState("");
  const [meshKind, setMeshKind] = useState<"side" | "integrated">("side"); const [layout, setLayout] = useState<"packages" | "apps">("apps"); const [meshName, setMeshName] = useState("mesh"); const [goal, setGoal] = useState("");
  const [portRepo, setPortRepo] = useState<string>("");
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [output, setOutput] = useState<Output | null>(null);
  const [tasks, setTasks] = useState<AgentTask[]>([]); const [skip, setSkip] = useState<Set<string>>(new Set()); const [running, setRunning] = useState(false); const abort = useRef<AbortController | null>(null);
  const [brief, setBrief] = useState("");
  const [ghName, setGhName] = useState(""); const [ghPrivate, setGhPrivate] = useState(true); const [pushing, setPushing] = useState(false);

  useEffect(() => { void ghToken().then((t) => setHasToken(!!t)); }, []);
  const parsed = useMemo(() => parseRepoList(text), [text]);
  const good = (inspect?.repos.filter((r) => r.ok) ?? []) as RepoSummary[];
  const assessment = useMemo(() => (good.length ? assessRip(good.map((r) => ({ repo: `${r.ref.owner}/${r.ref.repo}`, licenses: r.licenses })), mode) : null), [good, mode]);
  const blocked = !!assessment?.requiresAttestation && !attested;
  useEffect(() => { if (good.length && !portRepo) setPortRepo(good[0]!.url); }, [good, portRepo]);
  useEffect(() => { if (params.get("repos") && !inspect && !busy) void doInspect(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function doInspect() {
    setErr(null); setOutput(null); setTasks([]); setInspect(null); setAttested(false);
    if (!parsed.refs.length) return setErr(parsed.errors[0]?.error ?? "Paste at least one GitHub repository (owner/name or URL).");
    setBusy(true);
    try { const token = useToken ? await ghToken() : undefined; const tokens = [...new Set(text.split(/[\n,;\s]+/).map((t) => t.trim()).filter(Boolean))].filter((t) => !parsed.errors.some((e) => e.line === t)); const r = await inspectRepos(tokens, { token, purpose: mode }); setInspect(r); if (!r.repos.some((x) => x.ok)) setErr("None of those repositories could be read."); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function fetchAll(): Promise<RepoSnapshot[]> {
    const token = useToken ? await ghToken() : undefined; const out: RepoSnapshot[] = [];
    for (const r of good) {
      const label = `${r.ref.owner}/${r.ref.repo}`; setProgress({ label, done: 0, total: r.files });
      out.push(await fetchRepoSnapshot(r.url, { token, onProgress: (n, total) => setProgress({ label, done: n, total: total || r.files }) }));
    }
    setProgress(null); return out;
  }

  async function run() {
    if (!assessment || blocked) return;
    setBusy(true); setErr(null); setOutput(null); setTasks([]); setSkip(new Set());
    try {
      const snaps = await fetchAll();
      const a = assessRip(snaps.map((s) => ({ repo: `${s.ref.owner}/${s.ref.repo}`, licenses: s.licenses })), mode); // re-assessed from the files actually downloaded
      if (mode === "clone") {
        const files = new Map<string, Uint8Array>(); const text: Record<string, string> = {}; const notes: string[] = [];
        for (const s of snaps) { const p = buildClonePackage(s, a, { prefix: snaps.length > 1 ? s.ref.repo : undefined, attested }); p.files.forEach((v, k) => files.set(k, v)); Object.assign(text, p.textFiles); notes.push(...p.notes); }
        const name = snaps.length === 1 ? snaps[0]!.ref.repo : `${snaps.length}-repos`; setGhName(slug(name + "-copy"));
        setOutput({ kind: "clone", files, textFiles: text, notes, name });
      } else if (mode === "mesh" && meshKind === "side") {
        const m = meshRepos(snaps, a, { name: meshName, layout, attested }); const dec = new TextDecoder("utf-8", { fatal: false }); const text: Record<string, string> = {};
        m.files.forEach((v, k) => { if (v.byteLength < 1_500_000 && !v.subarray(0, 4000).includes(0)) text[k] = dec.decode(v); });
        setGhName(slug(meshName)); setOutput({ kind: "mesh", files: m.files, textFiles: text, notes: m.report.notes, report: m.report, name: meshName });
      } else {
        if (!models.length) throw new Error("Connect an AI model first (AI Studio → Providers, or start a local model). Cloning and side-by-side meshing work without one.");
        const target = stackById(stackId); let plan: AgentTask[];
        if (mode === "port") { const s = snaps.find((x) => x.ref.repo && good.find((g) => g.url === portRepo)?.ref.repo === x.ref.repo) ?? snaps[0]!; const p = buildPortPlan(s, { targetStackId: stackId, note: note || undefined }); plan = p.tasks; if (p.omitted) toast.warning(`${p.omitted} source files were too large to include in the plan and will be listed as gaps.`); setBrief(`Re-creating ${s.ref.owner}/${s.ref.repo} as ${target.label}. ${note}`); }
        else { plan = buildMeshPlan(snaps, { goal: goal || "a single app that combines the best of each repository", targetStackId: stackId }); setBrief(`Integrating ${snaps.map((s) => s.ref.repo).join(", ")} into one ${target.label} app. ${goal}`); }
        const label = mode === "port" ? `${snaps.find((x) => good.find((g) => g.url === portRepo)?.ref.repo === x.ref.repo)?.ref.repo ?? snaps[0]!.ref.repo} → ${target.label}` : `${snaps.map((s) => s.ref.repo).join(" + ")} → ${target.label}`;
        await newProject(label); setGhName(slug(label.split("→")[0] ?? label) + "-" + stackId);
        setTasks(plan);
      }
    } catch (e) { setErr(e instanceof RightsError ? e.message : (e as Error).message); setProgress(null); } finally { setBusy(false); }
  }

  async function runTasks() {
    const ctrl = new AbortController(); abort.current = ctrl; setRunning(true);
    try { const done = await runPlan(tasks, { onUpdate: setTasks, signal: ctrl.signal, skip, brief }); setTasks(done); const bad = done.filter((t) => t.status === "failed" || t.status === "blocked").length; bad ? toast.warning(`${bad} task(s) need attention — open them for the failing check.`) : toast.success("Plan complete — files are in the workspace."); }
    catch (e) { if ((e as Error).name !== "AbortError") toast.error((e as Error).message); } finally { setRunning(false); abort.current = null; }
  }

  const toWorkspace = async () => {
    if (!output) return;
    const total = Object.values(output.textFiles).reduce((n, s) => n + s.length, 0);
    if (total > 40_000_000) return toast.error("That's too large for the in-browser workspace — download the ZIP or push to GitHub instead.");
    await newProject(output.name); mutate((p) => ({ ...p, name: output.name, workspace: { ...p.workspace, files: output.textFiles } })); toast.success(`${Object.keys(output.textFiles).length} files in the workspace`); nav("/workspace");
  };
  const push = async (files: { path: string; data: Uint8Array | string }[]) => {
    setPushing(true);
    try { const r = await publishToGitHub(ghName || "omniforge-copy", files, { private: ghPrivate, description: `Created with OmniForge RE (${mode})` }); toast.success("Published", { description: r.url, action: { label: "Open", onClick: () => window.open(r.url, "_blank", "noopener") } }); }
    catch (e) { toast.error((e as Error).message); } finally { setPushing(false); }
  };
  const workspaceFiles = () => Object.entries(useApp.getState().project?.workspace.files ?? {}).map(([path, data]) => ({ path, data }));
  const planFinished = tasks.length > 0 && !running && tasks.every((t) => ["done", "skipped", "failed", "blocked"].includes(t.status)) && tasks.some((t) => t.status === "done");

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <SectionTitle title="Repo Rip" sub="Take one or many GitHub repositories and turn them into an exact copy, the same app in any other stack, or one app that meshes them together." />

      <Card>
        <CardBody className="space-y-3">
          <Field label="Repositories — one per line" hint="owner/name, a GitHub/GitLab URL, optionally with /tree/branch/subfolder. Public repos need no token."><Textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(8, Math.max(3, text.split("\n").length + 1))} spellCheck={false} placeholder={"vercel/next.js\nhttps://github.com/shadcn-ui/ui/tree/main/apps/www\nsindresorhus/awesome"} aria-label="Repositories" /></Field>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted">{parsed.refs.length > 0 && <Badge tone="teal">{parsed.refs.length} repo{parsed.refs.length > 1 ? "s" : ""}</Badge>}{parsed.errors.length > 0 && <Badge tone="warn" title={parsed.errors.map((e) => `${e.line}: ${e.error}`).join("\n")}>{parsed.errors.length} not recognised</Badge>}
              <label className={cn("flex items-center gap-2", !hasToken && "opacity-50")} title={hasToken ? "Send your saved GitHub token to GitHub only (never to any other host)" : "Add a token in Integrations → GitHub to read private repos"}><input type="checkbox" checked={useToken} disabled={!hasToken} onChange={(e) => setUseToken(e.target.checked)} />Use my GitHub token (private repos)</label></div>
            <Button variant="primary" loading={busy && !progress} icon={<Search className="size-4" />} onClick={doInspect} disabled={!parsed.refs.length}>Inspect</Button>
          </div>
          {err && <div role="alert" className="whitespace-pre-line rounded-lg border border-bad/30 bg-bad/10 p-3 text-[13px] text-bad">{err}</div>}
        </CardBody>
      </Card>

      {inspect && good.length > 0 && <>
        <section className="grid gap-3 md:grid-cols-2" aria-label="Inspected repositories">
          {inspect.repos.map((r) => r.ok ? <RepoCard key={r.url} r={r} /> : <Card key={r.url} className="border-bad/30 p-4"><div className="flex items-start gap-2 text-[13px] text-bad"><X className="mt-0.5 size-4 shrink-0" /><div><div className="font-medium">{r.url}</div><div className="text-muted">{r.error}</div></div></div></Card>)}
        </section>

        {assessment && <Card className={cn(assessment.level === "attestation-required" ? "border-bad/40" : assessment.level === "copyleft" ? "border-warn/40" : "border-ok/30")}>
          <CardHeader><CardTitle className="flex items-center gap-2">{assessment.level === "ok" || assessment.level === "attribution" ? <ShieldCheck className="size-4 text-ok" /> : <ShieldAlert className={cn("size-4", assessment.level === "attestation-required" ? "text-bad" : "text-warn")} />}Rights checkpoint</CardTitle><Badge tone={assessment.level === "attestation-required" ? "bad" : assessment.level === "copyleft" ? "warn" : "ok"}>{{ ok: "Free to use", attribution: "Attribution required", copyleft: "Copyleft", "attestation-required": "Permission needed" }[assessment.level]}</Badge></CardHeader>
          <CardBody className="space-y-3 text-[13px]">
            <ul className="space-y-2">{assessment.perRepo.map((p) => <li key={p.repo} className="space-y-0.5"><div className="flex items-center gap-2"><span className="font-medium">{p.repo}</span><Badge tone={LIC_TONE(p.license.class)}>{p.license.spdx}</Badge></div><p className="text-muted">{p.obligations[0]}</p></li>)}</ul>
            {assessment.conflicts.map((c) => <p key={c} className="flex gap-2 text-bad"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{c}</p>)}
            {assessment.messages.filter((m) => !assessment.perRepo.some((p) => m.startsWith(p.repo))).map((m, i) => <p key={i} className="text-muted">{m}</p>)}
            {assessment.requiresAttestation && <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-bg p-3"><input type="checkbox" className="mt-1" checked={attested} onChange={(e) => setAttested(e.target.checked)} /><span>I own this code, or the owner has given me permission to copy or adapt it. <span className="text-faint">(Required — nothing is copied until you confirm.)</span></span></label>}
            <p className="text-xs text-faint">Licence detection is automatic and not legal advice. An ATTRIBUTION.md and the original licence files are added to everything produced.</p>
          </CardBody>
        </Card>}

        <Card>
          <CardHeader><CardTitle>What should happen?</CardTitle></CardHeader>
          <CardBody className="space-y-5">
            <div className="grid gap-3 md:grid-cols-3" role="radiogroup" aria-label="Rip mode">
              {([["clone", Copy, "Exact copy", "Every file, byte-for-byte, plus attribution. Download, open in the workspace, or push to a new GitHub repo."], ["port", Wand2, "Re-create in another stack", "AI agents port it to any app type — web, desktop, mobile, CLI — with tests that must pass."], ["mesh", Layers, "Mesh together", "Side-by-side monorepo (instant, no AI), or one integrated app that combines what each repo does."]] as const).map(([id, Icon, t, d]) => (
                <button key={id} role="radio" aria-checked={mode === id} onClick={() => setMode(id)} className={cn("space-y-2 rounded-xl border p-4 text-left transition", mode === id ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong hover:bg-elevated")}><div className="flex items-center gap-2 text-sm font-semibold"><Icon className={cn("size-4", mode === id ? "text-accent" : "text-muted")} />{t}{mode === id && <Check className="ml-auto size-4 text-accent" />}</div><p className="text-[13px] text-muted">{d}</p></button>))}
            </div>

            {mode === "port" && <div className="grid gap-4 md:grid-cols-2">
              {good.length > 1 && <Field label="Which repository?" className="md:col-span-2"><Select value={portRepo} onValueChange={setPortRepo} options={good.map((r) => ({ value: r.url, label: `${r.ref.owner}/${r.ref.repo}` }))} /></Field>}
              <Field label="Target app type"><Select value={stackId} onValueChange={setStackId} options={STACKS.map((s) => ({ value: s.id, label: s.label, hint: s.kind }))} /></Field>
              <Field label={stackId === "any" ? "Describe the target (required)" : "Extra instructions (optional)"}><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={stackId === "any" ? "e.g. a Flutter app with a Supabase backend" : "e.g. keep the same routes, use Tailwind"} /></Field>
            </div>}
            {mode === "mesh" && <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3"><div role="radiogroup" className="inline-flex rounded-lg border border-line bg-bg p-0.5">{([["side", "Side-by-side monorepo"], ["integrated", "Integrated app (AI)"]] as const).map(([v, l]) => <button key={v} role="radio" aria-checked={meshKind === v} onClick={() => setMeshKind(v)} className={cn("rounded-md px-3 py-1.5 text-[13px] font-medium transition", meshKind === v ? "bg-overlay text-fg shadow-sm" : "text-muted hover:text-fg")}>{l}</button>)}</div><span className="text-xs text-muted">{meshKind === "side" ? "Keeps each repo intact in one workspace; resolves port clashes and reports dependency conflicts." : "AI designs one app that merges the capabilities; the plan is shown before anything runs."}</span></div>
              {meshKind === "side" ? <div className="grid gap-4 md:grid-cols-2"><Field label="Workspace name"><Input value={meshName} onChange={(e) => setMeshName(e.target.value)} /></Field><Field label="Layout"><Select value={layout} onValueChange={(v) => setLayout(v as "apps" | "packages")} options={[{ value: "apps", label: "apps/<repo>" }, { value: "packages", label: "packages/<repo>" }]} /></Field></div>
                : <div className="grid gap-4 md:grid-cols-2"><Field label="What should the combined app do?" className="md:col-span-2"><Textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} placeholder="e.g. A single dashboard that has repo A's editor and repo B's analytics" /></Field><Field label="Target app type"><Select value={stackId} onValueChange={setStackId} options={STACKS.map((s) => ({ value: s.id, label: s.label, hint: s.kind }))} /></Field></div>}
            </div>}
            {mode === "clone" && <p className="text-[13px] text-muted">Copies {fmtNum(good.reduce((n, r) => n + r.files, 0))} files ({fmtBytes(good.reduce((n, r) => n + r.bytes, 0))}){good.length > 1 ? `, each repo in its own folder` : ""}. Build output, <code>node_modules</code> and <code>.git</code> are skipped.</p>}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <div className="min-w-0 flex-1">{progress ? <div className="space-y-1.5"><div className="flex justify-between text-xs text-muted"><span className="truncate">Downloading {progress.label}</span><span className="tabular-nums">{progress.done}/{progress.total || "?"}</span></div><Progress value={progress.total ? progress.done / progress.total : 0.1} /></div> : blocked ? <span className="text-xs text-bad">Confirm permission above to continue.</span> : mode !== "clone" && !(mode === "mesh" && meshKind === "side") && !models.length ? <span className="text-xs text-warn">This mode needs an AI model — connect one in AI Studio.</span> : <span className="text-xs text-faint">Nothing is executed on your machine; files are only fetched and written to a new project.</span>}</div>
              <Button variant="primary" size="lg" onClick={run} loading={busy && !!progress} disabled={blocked || busy || good.length === 0 || (mode === "port" && stackId === "any" && !note.trim()) || (mode === "mesh" && good.length < 2)} icon={<GitFork className="size-4" />}>{mode === "clone" ? "Make the copy" : mode === "port" ? "Plan the port" : meshKind === "side" ? "Mesh them" : "Plan the mesh"}</Button>
            </div>
            {mode === "mesh" && good.length < 2 && <p className="text-xs text-warn">Meshing needs at least two repositories.</p>}
          </CardBody>
        </Card>
      </>}

      {tasks.length > 0 && <>
        <TaskRunner tasks={tasks} setTasks={setTasks} skip={skip} setSkip={setSkip} running={running} onRun={runTasks} onStop={() => abort.current?.abort()} title={mode === "port" ? "Port plan" : "Mesh plan"} disabledReason={!models.length ? "Connect an AI model to run this plan." : settings.localOnly && !models.some((m) => m.local) ? "Local-only mode is on and no local model is available." : undefined} />
        {planFinished && <Card><CardBody className="flex flex-wrap items-center gap-3"><span className="text-sm font-medium">Result is in your workspace.</span><div className="ml-auto flex flex-wrap gap-2"><Button variant="primary" onClick={() => nav("/workspace")} icon={<ArrowRight className="size-4" />}>Open workspace</Button><Button variant="secondary" icon={<Download className="size-4" />} onClick={() => { const f = workspaceFiles(); download(`${ghName || "result"}.zip`, zipPackage(new Map(f.map((x) => [x.path, new TextEncoder().encode(x.data)]))), "application/zip"); }}>ZIP</Button><PushControls name={ghName} setName={setGhName} priv={ghPrivate} setPriv={setGhPrivate} busy={pushing} onPush={() => push(workspaceFiles())} /></div></CardBody></Card>}
      </>}

      {output && <Card className="border-ok/30">
        <CardHeader><CardTitle className="flex items-center gap-2"><Check className="size-4 text-ok" />{output.kind === "clone" ? "Copy ready" : "Mesh ready"}</CardTitle><span className="text-xs text-muted">{output.files.size} files</span></CardHeader>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap gap-2"><Button variant="primary" icon={<FolderGit2 className="size-4" />} onClick={toWorkspace}>Open in workspace</Button><Button variant="secondary" icon={<Download className="size-4" />} onClick={() => download(`${output.name}.zip`, zipPackage(output.files), "application/zip")}>Download ZIP</Button><PushControls name={ghName} setName={setGhName} priv={ghPrivate} setPriv={setGhPrivate} busy={pushing} onPush={() => push([...output.files].map(([path, data]) => ({ path, data })))} /></div>
          {output.notes.length > 0 && <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">{output.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          {output.report && <MeshReportView r={output.report} />}
        </CardBody>
      </Card>}
    </div>
  );
}

function PushControls({ name, setName, priv, setPriv, busy, onPush }: { name: string; setName: (v: string) => void; priv: boolean; setPriv: (v: boolean) => void; busy: boolean; onPush: () => void }) {
  const [open, setOpen] = useState(false); const [has, setHas] = useState(true);
  useEffect(() => { void ghToken().then((t) => setHas(!!t)); }, [open]);
  if (!open) return <Button variant="secondary" icon={<Github className="size-4" />} onClick={() => setOpen(true)}>Push to GitHub</Button>;
  return <div className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-line bg-bg p-2"><Input className="h-8 min-w-40 flex-1" value={name} onChange={(e) => setName(slug(e.target.value))} aria-label="New repository name" /><label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />private</label><Button size="sm" variant="primary" loading={busy} disabled={!name || !has} title={has ? undefined : "Connect GitHub in Integrations first"} onClick={onPush}>Create & push</Button><Button size="icon-sm" variant="ghost" aria-label="Cancel" onClick={() => setOpen(false)}><X className="size-4" /></Button>{!has && <span className="w-full text-xs text-warn">No GitHub token saved — add one in Integrations → GitHub.</span>}</div>;
}

function RepoCard({ r }: { r: RepoSummary }) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="truncate text-sm font-semibold">{r.ref.owner}/{r.ref.repo}</div>{r.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{r.description}</p>}</div><Badge tone={LIC_TONE(r.effective.class)} title={`Licence source: ${r.effective.source}`}>{r.effective.spdx}</Badge></div>
      <div className="flex flex-wrap gap-1.5 text-xs"><Badge>{fmtNum(r.files)} file{r.files === 1 ? "" : "s"}</Badge><Badge>{fmtBytes(r.bytes)}</Badge>{r.stars !== undefined && <Badge>★ {fmtNum(r.stars)}</Badge>}{r.defaultBranch && <Badge>{r.defaultBranch}{r.sha ? `@${r.sha.slice(0, 7)}` : ""}</Badge>}{r.isPrivate && <Badge tone="warn">private</Badge>}</div>
      {r.frameworks.length > 0 && <div className="flex flex-wrap gap-1.5">{r.frameworks.slice(0, 6).map((f) => <Badge key={f} tone="accent">{f}</Badge>)}{r.buildSystems.slice(0, 3).map((f) => <Badge key={f}>{f}</Badge>)}</div>}
      <div className="grid grid-cols-4 gap-2 border-t border-line pt-3 text-center text-xs"><div><div className="text-sm font-semibold tabular-nums">{r.languages[0]?.language ?? "—"}</div><div className="text-faint">main lang</div></div><div><div className="text-sm font-semibold tabular-nums">{r.routes}</div><div className="text-faint">routes</div></div><div><div className="text-sm font-semibold tabular-nums">{r.components}</div><div className="text-faint">components</div></div><div><div className="text-sm font-semibold tabular-nums">{r.dependencies}</div><div className="text-faint">deps</div></div></div>
      {r.database.length > 0 && <p className="text-xs text-muted">Data layer: {r.database.map((d) => d.kind).join(", ")}</p>}
      {r.skipped > 0 && <p className="text-xs text-faint">{r.skipped} file(s) skipped (build output, binaries over the size cap, or limits).</p>}
    </Card>
  );
}

function MeshReportView({ r }: { r: MeshReport }) {
  return (
    <div className="space-y-4 text-[13px]">
      <div><h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-faint">Packages</h4><ul className="divide-y divide-line rounded-lg border border-line">{r.packages.map((p) => <li key={p.slug} className="flex flex-wrap items-center gap-2 px-3 py-2"><Boxes className="size-4 text-muted" /><span className="font-mono text-xs">{p.dir}</span><span className="text-muted">{p.repo}</span><span className="ml-auto flex gap-1.5">{p.frameworks.slice(0, 3).map((f) => <Badge key={f}>{f}</Badge>)}</span></li>)}</ul></div>
      {r.portAssignments.length > 0 && <div><h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-faint">Ports assigned (no clashes)</h4><div className="flex flex-wrap gap-1.5">{r.portAssignments.map((p, i) => <Badge key={i} title={p.reason}>{p.slug}: {p.port}</Badge>)}</div></div>}
      {r.dependencyConflicts.length > 0 && <div><h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-faint">Dependency version differences</h4><ul className="space-y-1.5">{r.dependencyConflicts.map((c) => <li key={c.name} className="flex gap-2"><Badge tone={c.compatible ? "ok" : "warn"}>{c.compatible ? "compatible" : "conflict"}</Badge><span><span className="font-mono text-xs">{c.name}</span> <span className="text-muted">{c.ranges.map((x) => `${x.repo} ${x.range}`).join(" · ")}. {c.suggestion}</span></span></li>)}</ul></div>}
      {r.nameCollisions.length > 0 && <p className="text-warn">Package name collisions renamed: {r.nameCollisions.join(", ")}</p>}
    </div>
  );
}
