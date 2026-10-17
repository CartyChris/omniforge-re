import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, CircleAlert, ExternalLink, Github, Loader2, Rocket, ShieldCheck, Triangle, XCircle, Download, RefreshCw, Plus, Trash2 } from "lucide-react";
import { uid, vercel, zipPackage } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { VC_KEY, publishToGitHub, vcOpts } from "@/lib/github";
import { vault } from "@/lib/vault";
import { blocked, detectFramework, preflight, probeUrl, type Check, type ProbeResult } from "@/lib/deploy";
import { requestApproval } from "@/lib/approvals";
import { ago, cn, download } from "@/lib/utils";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, Field, Input, SectionTitle, Segmented } from "@/components/ui/primitives";
import { useNavigate } from "react-router";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 52) || "app";
const ICON = { pass: <CheckCircle2 className="size-4 text-ok" />, warn: <CircleAlert className="size-4 text-warn" />, fail: <XCircle className="size-4 text-bad" /> };

export default function Deployments() {
  const { project, mutate, settings } = useApp(); const nav = useNavigate();
  const files = project?.workspace.files ?? {};
  const checks = useMemo(() => preflight(files), [files]);
  const fw = useMemo(() => detectFramework(files), [files]);
  const stop = blocked(checks);
  const [hasVc, setHasVc] = useState(false);
  useEffect(() => { void vault.get(VC_KEY).then((t) => setHasVc(!!t)).catch(() => {}); }, []);
  const record = (d: { provider: "vercel" | "github" | "local"; url?: string; status: string; detail?: string }) => mutate((p) => ({ ...p, deployments: [{ id: uid("dep"), at: new Date().toISOString(), ...d }, ...p.deployments] }));

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <SectionTitle title="Deployments" sub="Ship the active project to Vercel or GitHub. A deployment only counts as live after its URL is fetched and answers — never because an API call returned." />
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" />Pre-flight checks</CardTitle><span className="text-xs text-muted">{project?.name}</span></CardHeader>
        <ul className="divide-y divide-line">{checks.map((c) => <li key={c.id} className="flex items-start gap-3 px-4 py-2.5 text-[13px]">{ICON[c.status]}<div><span className="font-medium">{c.label}</span><span className="text-muted"> — {c.detail}</span></div></li>)}</ul>
        {Object.keys(files).length === 0 && <div className="border-t border-line p-4"><Button variant="secondary" onClick={() => nav("/studio")}>Build something in AI Studio</Button></div>}
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <VercelPanel files={files} fw={fw} blocked={stop} hasToken={hasVc} name={slug(project?.name ?? "app")} record={record} teamId={settings.vercel.teamId} />
        <GitHubPanel files={files} blocked={stop} name={slug(project?.name ?? "app")} record={record} />
      </div>
      <Card><CardBody className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-medium">Download only</p><p className="text-xs text-muted">Get a ZIP of the project to deploy anywhere yourself.</p></div><Button variant="secondary" icon={<Download className="size-4" />} disabled={!Object.keys(files).length} onClick={() => { download(`${slug(project?.name ?? "app")}.zip`, zipPackage(new Map(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)]))), "application/zip"); record({ provider: "local", status: "exported ZIP" }); }}>Download ZIP</Button></CardBody></Card>
      <History />
    </div>
  );
}

function VercelPanel({ files, fw, blocked: stop, hasToken, name, record, teamId }: { files: Record<string, string>; fw: ReturnType<typeof detectFramework>; blocked: boolean; hasToken: boolean; name: string; record: (d: any) => void; teamId?: string }) {
  const nav = useNavigate();
  const [n, setN] = useState(name); const [target, setTarget] = useState<"preview" | "production">("preview"); const [env, setEnv] = useState<{ k: string; v: string }[]>([]);
  const [build, setBuild] = useState(""); const [out, setOut] = useState("");
  const [state, setState] = useState<{ step: string; log?: string[]; url?: string; probe?: ProbeResult; error?: string } | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => setN(name), [name]);
  const run = async () => {
    const ok = await requestApproval({ kind: "deploy", title: `Deploy “${n}” to Vercel (${target})?`, detail: `${Object.keys(files).length} files will be uploaded to your Vercel account${teamId ? " (team)" : ""}. ${target === "production" ? "This updates the production site." : "A preview URL will be created."}` });
    if (!ok) return;
    setBusy(true); setState({ step: "Uploading files…" });
    try {
      const o = await vcOpts();
      const d = await vercel.createDeployment(o, Object.entries(files).map(([path, data]) => ({ path, data })), { name: n, target, framework: fw.id, buildCommand: build || undefined, outputDirectory: out || fw.output || undefined, env: Object.fromEntries(env.filter((e) => e.k.trim()).map((e) => [e.k.trim(), e.v])) });
      setState({ step: "Building…", url: d.url });
      const r = await vercel.waitForDeployment(o, d.id, (s) => setState((p) => ({ ...p!, step: s === "READY" ? "Verifying the live URL…" : `Vercel: ${s.toLowerCase()}…` })));
      if (r.readyState !== "READY") {
        const log = await vercel.buildLog(o, d.id).catch(() => []);
        setState({ step: "Failed", error: r.errorMessage, log: log.slice(-40), url: d.url }); record({ provider: "vercel", url: d.url, status: "failed", detail: r.errorMessage }); return;
      }
      setState({ step: "Verifying the live URL…", url: r.url });
      let probe: ProbeResult; try { probe = await probeUrl(r.url); } catch (e) { probe = { ok: false, status: 0, ms: 0, error: (e as Error).message }; }
      setState({ step: probe.ok ? "Live" : probe.protected ? "Protected" : "Not verified", url: r.url, probe });
      record({ provider: "vercel", url: r.url, status: probe.ok ? `live — verified HTTP ${probe.status} in ${probe.ms} ms` : probe.protected ? "built — URL is behind Vercel Deployment Protection (not publicly verifiable)" : `built, but verification failed: ${probe.error ?? `HTTP ${probe.status}`}` });
    } catch (e) { setState({ step: "Failed", error: (e as Error).message }); record({ provider: "vercel", status: "failed", detail: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Triangle className="size-4" />Vercel</CardTitle>{hasToken ? <Badge tone="ok" dot>connected</Badge> : <Badge>not connected</Badge>}</CardHeader>
      <CardBody className="space-y-4">
        {!hasToken ? <div className="space-y-3 text-[13px] text-muted"><p>Connect a Vercel token to deploy from here.</p><Button variant="secondary" onClick={() => nav("/integrations")}>Connect Vercel</Button></div> : <>
          <div className="grid grid-cols-2 gap-3"><Field label="Project name"><Input value={n} onChange={(e) => setN(slug(e.target.value))} /></Field><Field label="Target"><Segmented value={target} onChange={setTarget} options={[{ value: "preview", label: "Preview" }, { value: "production", label: "Production" }]} size="sm" /></Field></div>
          <p className="text-xs text-muted">Detected: <b>{fw.label}</b>{fw.id ? ` (preset ${fw.id})` : ""}</p>
          <details className="text-[13px]"><summary className="cursor-pointer text-muted hover:text-fg">Build overrides & environment variables</summary><div className="mt-3 space-y-3"><div className="grid grid-cols-2 gap-3"><Field label="Build command"><Input value={build} onChange={(e) => setBuild(e.target.value)} placeholder="auto" /></Field><Field label="Output directory"><Input value={out} onChange={(e) => setOut(e.target.value)} placeholder="auto" /></Field></div>
            <div className="space-y-2"><p className="text-xs font-medium text-muted">Environment variables (values are sent to Vercel, never saved here)</p>{env.map((e, i) => <div key={i} className="flex gap-2"><Input className="h-8" value={e.k} placeholder="NAME" onChange={(x) => setEnv(env.map((y, j) => (j === i ? { ...y, k: x.target.value.toUpperCase() } : y)))} /><Input className="h-8" type="password" value={e.v} placeholder="value" onChange={(x) => setEnv(env.map((y, j) => (j === i ? { ...y, v: x.target.value } : y)))} /><Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => setEnv(env.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button></div>)}<Button size="xs" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setEnv([...env, { k: "", v: "" }])}>Add variable</Button></div></div></details>
          <Button variant="primary" icon={busy ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />} disabled={stop || busy || !n} onClick={run} title={stop ? "Fix the failing pre-flight checks first" : undefined}>Deploy to Vercel</Button>
          {stop && <p className="text-xs text-bad">Resolve the failing checks above first.</p>}
          {state && <div className={cn("space-y-2 rounded-xl border p-3 text-[13px]", state.step === "Live" ? "border-ok/40 bg-ok/5" : state.step === "Failed" || state.step === "Not verified" ? "border-bad/40 bg-bad/5" : state.step === "Protected" ? "border-warn/40 bg-warn/5" : "border-line")}>
            <div className="flex items-center gap-2 font-medium">{state.step === "Live" ? <CheckCircle2 className="size-4 text-ok" /> : state.step === "Failed" || state.step === "Not verified" ? <XCircle className="size-4 text-bad" /> : state.step === "Protected" ? <CircleAlert className="size-4 text-warn" /> : <Loader2 className="size-4 animate-spin" />}{state.step}</div>
            {state.url && <a href={state.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-accent hover:underline">{state.url}<ExternalLink className="size-3 shrink-0" /></a>}
            {state.probe && <p className="text-xs text-muted">{state.probe.ok ? `Fetched by our server: HTTP ${state.probe.status} in ${state.probe.ms} ms${state.probe.title ? ` — “${state.probe.title}”` : ""}.` : state.probe.protected ? "Vercel Deployment Protection requires a login to view this URL. Turn it off in the project's settings for a public site. The build itself succeeded." : `Not verified: ${state.probe.error ?? `HTTP ${state.probe.status}`}`}</p>}
            {state.error && <p className="text-bad">{state.error}</p>}
            {state.log && state.log.length > 0 && <pre className="max-h-48 overflow-auto rounded-lg border border-line bg-bg p-2 font-mono text-[11px] text-muted">{state.log.join("\n")}</pre>}
          </div>}
        </>}
      </CardBody></Card>
  );
}

function GitHubPanel({ files, blocked: stop, name, record }: { files: Record<string, string>; blocked: boolean; name: string; record: (d: any) => void }) {
  const { settings } = useApp(); const nav = useNavigate();
  const [n, setN] = useState(name); const [priv, setPriv] = useState(true); const [busy, setBusy] = useState(false); const [url, setUrl] = useState<string | null>(null);
  useEffect(() => setN(name), [name]);
  const connected = !!settings.github.login;
  const push = async () => {
    setBusy(true);
    try { const r = await publishToGitHub(n, Object.entries(files).map(([path, data]) => ({ path, data })), { private: priv, description: "Created with OmniForge RE" }); setUrl(r.url); record({ provider: "github", url: r.url, status: `pushed ${Object.keys(files).length} files (commit ${String(r.commit?.sha ?? "").slice(0, 7)})` }); toast.success("Pushed to GitHub"); }
    catch (e) { toast.error((e as Error).message); record({ provider: "github", status: "failed", detail: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Github className="size-4" />GitHub</CardTitle>{connected ? <Badge tone="ok" dot>{settings.github.login}</Badge> : <Badge>not connected</Badge>}</CardHeader>
      <CardBody className="space-y-4">
        {!connected ? <div className="space-y-3 text-[13px] text-muted"><p>Connect GitHub to create a repository and push the project as a single commit.</p><Button variant="secondary" onClick={() => nav("/integrations")}>Connect GitHub</Button></div> : <>
          <Field label="New repository name"><Input value={n} onChange={(e) => setN(slug(e.target.value))} /></Field>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />Private repository</label>
          <Button variant="primary" icon={busy ? <Loader2 className="size-4 animate-spin" /> : <Github className="size-4" />} disabled={stop || busy || !n} onClick={push}>Create repo & push</Button>
          {url && <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[13px] text-accent hover:underline">{url}<ExternalLink className="size-3" /></a>}
        </>}
      </CardBody></Card>
  );
}

function History() {
  const { project, mutate } = useApp(); const [busy, setBusy] = useState<string | null>(null);
  const list = project?.deployments ?? [];
  const reverify = async (id: string, url: string) => { setBusy(id); try { const p = await probeUrl(url); mutate((pr) => ({ ...pr, deployments: pr.deployments.map((d) => (d.id === id ? { ...d, status: p.ok ? `live — re-verified HTTP ${p.status} in ${p.ms} ms` : p.protected ? "protected by Vercel Deployment Protection" : `unreachable: ${p.error ?? `HTTP ${p.status}`}` } : d)) })); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); } };
  return (
    <Card><CardHeader><CardTitle>History</CardTitle><span className="text-xs text-muted">{list.length}</span></CardHeader>
      {list.length === 0 ? <EmptyState icon={<Rocket className="size-5" />} title="Nothing deployed yet" body="Deployments, pushes and exports appear here with their verification result." /> :
        <ul className="divide-y divide-line">{list.map((d) => <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]"><Badge tone={/^live|pushed|exported/.test(d.status) ? "ok" : /protect|built/.test(d.status) ? "warn" : "bad"}>{d.provider}</Badge><div className="min-w-0 flex-1"><div className="truncate">{d.status}{d.detail ? ` — ${d.detail}` : ""}</div>{d.url && <a className="truncate text-xs text-accent hover:underline" href={d.url} target="_blank" rel="noopener noreferrer">{d.url}</a>}</div><span className="text-xs text-faint">{ago(d.at)}</span>{d.url && d.provider === "vercel" && <Button size="icon-sm" variant="ghost" aria-label="Re-verify" title="Fetch the URL again" onClick={() => reverify(d.id, d.url!)}><RefreshCw className={cn("size-3.5", busy === d.id && "animate-spin")} /></Button>}</li>)}</ul>}
    </Card>
  );
}
