import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Bot, CheckCircle2, ExternalLink, Github, HardDrive, Link2, Loader2, PlugZap, RefreshCw, RotateCcw, ShieldAlert, Triangle, Unplug, Wrench, XCircle } from "lucide-react";
import { github, vercel } from "@omniforge/core";
import { isDesktop, useApp } from "@/lib/store";
import { pair, probe } from "@/lib/bridge";
import { vault } from "@/lib/vault";
import { runHealthCheck, type HealthCheck } from "@/lib/health";
import { refreshModels } from "@/lib/ai";
import { audit } from "@/lib/audit";
import { download } from "@/lib/utils";
import { Link } from "react-router";
import { GH_KEY, VC_KEY, appFetch, vcOpts } from "@/lib/github";
import { requestApproval } from "@/lib/approvals";
import { ago, cn } from "@/lib/utils";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, CopyButton, Field, Input, SectionTitle, StatusDot } from "@/components/ui/primitives";
import { Select } from "@/components/ui/overlay";

const releases = "https://github.com/CartyChris/omniforge-re/releases";

export default function Integrations() {
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <SectionTitle title="Integrations" sub="Connect GitHub and Vercel, pair the desktop app, and see which tools and AI CLIs OmniForge found on your Mac." />
      <div className="grid gap-5 lg:grid-cols-2"><GitHubCard /><VercelCard /></div>
      <SetupCard />
      <Companion />
      <McpServerCard />
      <DesktopOnly />
    </div>
  );
}

function useToken(key: string) {
  const [has, setHas] = useState<boolean | null>(null);
  const refresh = useCallback(async () => { try { setHas(!!(await vault.get(key))); } catch { setHas(null); } }, [key]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { has, refresh };
}

function GitHubCard() {
  const { settings, patchSettings } = useApp(); const { has, refresh } = useToken(GH_KEY);
  const [token, setToken] = useState(""); const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try { const me = await github.whoami({ token: token.trim(), fetch: appFetch() }); await vault.set(GH_KEY, token.trim()); patchSettings({ github: { login: me.login } }); setToken(""); await refresh(); toast.success(`Connected as ${me.login}`); }
    catch (e) { toast.error(/401|Bad credentials/i.test((e as Error).message) ? "GitHub rejected that token." : (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Github className="size-4" />GitHub</CardTitle>{has ? <Badge tone="ok" dot>{settings.github.login ?? "connected"}</Badge> : <Badge>not connected</Badge>}</CardHeader>
      <CardBody className="space-y-3">
        <p className="text-[13px] text-muted">Used to read private repos in Repo Rip and to create repos and commit generated code. Commits are only made after you approve each one.</p>
        {has ? <div className="flex gap-2"><Button variant="secondary" icon={<Unplug className="size-4" />} onClick={async () => { await vault.del(GH_KEY); patchSettings({ github: {} }); await refresh(); toast.success("GitHub disconnected"); }}>Disconnect</Button></div>
          : <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void connect(); }}><Field label="Personal access token" hint={<>Create a fine-grained token with <b>Contents: read/write</b> and <b>Administration: write</b> (to create repos) — or a classic token with <code>repo</code>. <a className="text-accent underline" target="_blank" rel="noopener noreferrer" href="https://github.com/settings/personal-access-tokens/new">Create one</a></>}><Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" /></Field><Button type="submit" variant="primary" loading={busy} disabled={token.trim().length < 20}>Verify & save</Button></form>}
        <p className="text-xs text-faint">Stored encrypted on this device; sent only to api.github.com.</p>
      </CardBody></Card>
  );
}

function VercelCard() {
  const { settings, patchSettings } = useApp(); const { has, refresh } = useToken(VC_KEY);
  const [token, setToken] = useState(""); const [busy, setBusy] = useState(false); const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const load = useCallback(async () => { try { setTeams((await vercel.listTeams(await vcOpts())) as { id: string; name: string }[]); } catch { setTeams([]); } }, []);
  useEffect(() => { if (has) void load(); }, [has, load]);
  const connect = async () => {
    setBusy(true);
    try { const t = await vercel.listTeams({ token: token.trim(), fetch: appFetch() }); await vault.set(VC_KEY, token.trim()); setToken(""); await refresh(); toast.success(`Vercel connected (${(t as unknown[]).length} team${(t as unknown[]).length === 1 ? "" : "s"})`); }
    catch (e) { toast.error(/401|403|invalid/i.test((e as Error).message) ? "Vercel rejected that token." : (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Triangle className="size-4" />Vercel</CardTitle>{has ? <Badge tone="ok" dot>connected</Badge> : <Badge>not connected</Badge>}</CardHeader>
      <CardBody className="space-y-3">
        <p className="text-[13px] text-muted">Deploy generated apps. A deployment only counts as live after its URL is fetched and returns a healthy response.</p>
        {has ? <div className="space-y-3">{teams.length > 0 && <Field label="Deploy under"><Select value={settings.vercel.teamId ?? "personal"} onValueChange={(v) => patchSettings({ vercel: { teamId: v === "personal" ? undefined : v } })} options={[{ value: "personal", label: "Personal account" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} /></Field>}<Button variant="secondary" icon={<Unplug className="size-4" />} onClick={async () => { await vault.del(VC_KEY); patchSettings({ vercel: {} }); await refresh(); toast.success("Vercel disconnected"); }}>Disconnect</Button></div>
          : <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void connect(); }}><Field label="Access token" hint={<><a className="text-accent underline" target="_blank" rel="noopener noreferrer" href="https://vercel.com/account/tokens">Create a token</a> with the narrowest scope that works.</>}><Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="vercel token" /></Field><Button type="submit" variant="primary" loading={busy} disabled={token.trim().length < 20}>Verify & save</Button></form>}
        <p className="text-xs text-faint">Stored encrypted on this device; sent only to api.vercel.com.</p>
      </CardBody></Card>
  );
}

function Companion() {
  const { bridgeState, bridgeInfo, bridge, connectBridge, disconnectBridge, settings, patchSettings, bridgeError } = useApp();
  const [url, setUrl] = useState(settings.bridgeUrl); const [code, setCode] = useState(""); const [busy, setBusy] = useState(false); const [found, setFound] = useState<boolean | undefined | null>(undefined);
  // Looking for the app means a request to localhost, which browsers may gate behind a permission prompt: do it on demand.
  const look = useCallback(async () => { setFound(null); setFound(!!(await probe(url, 1500))); }, [url]);
  const doPair = async () => { setBusy(true); try { const c = await pair(url, code); patchSettings({ bridgeUrl: url }); await connectBridge(c); setCode(""); toast.success("Paired with the desktop app"); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  const connected = bridgeState === "connected";
  return (
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><HardDrive className="size-4" />Desktop app</CardTitle><Badge tone={connected ? "ok" : "neutral"} dot>{connected ? `connected · v${bridgeInfo?.version}` : bridgeState === "lost" ? "connection lost" : "not connected"}</Badge></CardHeader>
      <CardBody className="space-y-4">
        {isDesktop() && !connected ? <div role="alert" className="space-y-1 rounded-lg border border-bad/30 bg-bad/10 p-3 text-[13px] text-bad"><p className="font-medium">The built-in engine isn't reachable.</p><p className="break-words">{bridgeError ?? "Unknown error."}</p><p className="text-xs text-muted">Choose Help → Open Log Folder and send engine.log if this persists.</p></div>
          : connected ? <div className="flex flex-wrap items-center gap-3 text-[13px]"><span className="text-muted">Local folders, installed-app inspection, REA, AI CLIs, local models and git are unlocked.</span><span className="text-xs text-faint">{bridgeInfo?.system.platform} {bridgeInfo?.system.arch}{bridgeInfo?.system.appleSilicon ? " · Apple Silicon" : ""}</span><div className="ml-auto flex gap-2">{bridge?.conn.kind === "session" && <Button variant="secondary" icon={<Unplug className="size-4" />} onClick={disconnectBridge}>Unpair</Button>}</div></div>
          : <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-2 text-[13px] text-muted"><p className="font-medium text-fg">The macOS app unlocks everything</p><p>Install OmniForge RE for macOS (Apple Silicon or Intel), open <b>Settings → Pair a browser</b>, then enter the code here. The connection is loopback-only, authenticated, and scoped — the browser can never run commands or write files unless you grant it per session.</p><a className="inline-flex items-center gap-1 text-accent hover:underline" href={releases} target="_blank" rel="noopener noreferrer">Get the macOS app<ExternalLink className="size-3.5" /></a></div>
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void doPair(); }}>
              <Field label="App address"><Input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} /></Field>
              <p className="flex items-center gap-2 text-xs">{found === null ? <Loader2 className="size-3.5 animate-spin" /> : <StatusDot tone={found ? "ok" : "idle"} />}<span className={found ? "text-ok" : "text-muted"}>{found === undefined ? "Not checked yet" : found === null ? "Looking for the app…" : found ? "Desktop app found" : "Not found — is OmniForge RE running on this Mac?"}</span><button type="button" className="ml-auto text-accent hover:underline" onClick={look}>Check</button></p>
              <Field label="Pairing code"><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-1234" className="font-mono tracking-widest" autoComplete="off" /></Field>
              <Button type="submit" variant="primary" icon={<Link2 className="size-4" />} loading={busy} disabled={found === false || code.trim().length < 4}>Pair</Button>
            </form></div>}
      </CardBody></Card>
  );
}

const ST: Record<string, "ok" | "warn" | "bad" | "neutral"> = { ready: "ok", available: "ok", found: "ok", "not-installed": "neutral", missing: "neutral", "needs-configuration": "warn", "needs-auth": "warn", unsupported: "bad", error: "bad" };

const MCP_BIN = "/Applications/OmniForge RE.app/Contents/MacOS/omniforge-bridge";
const MCP_CLAUDE = `claude mcp add omniforge -- "${MCP_BIN}" mcp`;
const MCP_JSON = JSON.stringify({ mcpServers: { omniforge: { command: MCP_BIN, args: ["mcp"] } } }, null, 2);

/** Other coding agents can call OmniForge as an MCP server — read/plan tools only. */
function McpServerCard() {
  return (
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><PlugZap className="size-4" />Use OmniForge from Claude Code, Cursor and other MCP clients</CardTitle></CardHeader>
      <CardBody className="space-y-3 text-[13px]">
        <p className="text-muted">The desktop app includes an MCP server with four tools: <code>analyze_url</code>, <code>list_investigations</code>, <code>get_investigation</code> and <code>rebuild_plan</code>. They only read and plan — nothing writes files, runs commands or deploys — and public websites only (private and local addresses are refused). Everything about a site is returned as untrusted data.</p>
        <div className="space-y-1.5"><p className="text-xs font-medium text-muted">Claude Code (run in a terminal)</p><div className="flex items-start gap-2"><code tabIndex={0} aria-label="Claude Code command" className="block min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-lg bg-overlay px-3 py-2 font-mono text-xs" data-testid="mcp-claude">{MCP_CLAUDE}</code><CopyButton text={MCP_CLAUDE} /></div></div>
        <div className="space-y-1.5"><p className="text-xs font-medium text-muted">Other clients (Claude Desktop, Cursor… — add to their MCP settings)</p><div className="flex items-start gap-2"><pre tabIndex={0} aria-label="MCP client configuration" className="block min-w-0 flex-1 overflow-x-auto rounded-lg bg-overlay px-3 py-2 font-mono text-xs" data-testid="mcp-json">{MCP_JSON}</pre><CopyButton text={MCP_JSON} /></div></div>
        <p className="text-xs text-faint">Paths assume the app is in /Applications. Add <code>--allow-private</code> after <code>mcp</code> only if you want it to analyse sites on this computer or your network.</p>
      </CardBody></Card>
  );
}

function DesktopOnly() {
  const { bridge, bridgeState, bridgeInfo, refreshBridge } = useApp();
  if (bridgeState !== "connected" || !bridge || !bridgeInfo) return (
    <Card className="border-dashed"><CardBody className="flex items-center gap-4"><div className="grid size-10 place-items-center rounded-xl bg-overlay text-muted"><Wrench className="size-5" /></div><div className="text-[13px] text-muted"><p className="text-sm font-medium text-fg">Dev tools, AI CLIs and REA</p>Detection of Claude Code, Codex, Gemini CLI, OpenCode, Aider, REA, Ghidra, Xcode and more runs on your Mac, so it appears here once the desktop app is paired.</div></CardBody></Card>
  );
  const tools = bridgeInfo.tools; const groups = [...new Set(tools.map((t) => t.category))];
  return (
    <>
      <Clis />
      <Rea />
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><Wrench className="size-4" />Tools found on this Mac</CardTitle><Button size="xs" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => refreshBridge(true)}>Refresh</Button></CardHeader>
        <div className="divide-y divide-line">{groups.map((g) => <div key={g} className="px-4 py-3"><p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-faint">{g}</p><div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">{tools.filter((t) => t.category === g).map((t) => <div key={t.id} className="flex items-center gap-2 text-[13px]"><StatusDot tone={t.status === "found" ? "ok" : t.status === "needs-configuration" ? "warn" : "idle"} /><span className={cn("min-w-0 flex-1 truncate", t.status !== "found" && "text-muted")}>{t.name}</span><span className="max-w-[10rem] truncate text-xs text-faint" title={t.path ?? t.install}>{t.status === "found" ? (t.version ?? "found") : t.install ? <button className="hover:text-fg" title={`Install: ${t.install}`} onClick={() => navigator.clipboard?.writeText(t.install!).then(() => toast.success("Install command copied"))}>{t.install}</button> : "not installed"}</span></div>)}</div></div>)}</div></Card>
    </>
  );
}

function Clis() {
  const { bridge, bridgeInfo, refreshBridge } = useApp(); const [testing, setTesting] = useState<string | null>(null); const [res, setRes] = useState<Record<string, any>>({});
  const test = async (id: string) => { setTesting(id); try { setRes({ ...res, [id]: await bridge!.post(`/bridge/cli/test`, { id }) }); } catch (e) { toast.error((e as Error).message); } finally { setTesting(null); } };
  return (
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Bot className="size-4" />AI coding CLIs</CardTitle><Button size="xs" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => refreshBridge(true)}>Rescan</Button></CardHeader>
      <ul className="divide-y divide-line">{(bridgeInfo?.clis ?? []).map((c: any) => { const r = res[c.id]?.verified ?? c.verified; return (
        <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]"><StatusDot tone={c.status === "ready" ? "ok" : c.status === "not-installed" ? "idle" : "warn"} /><div className="min-w-0 flex-1"><div className="font-medium">{c.name} <span className="text-xs font-normal text-faint">{c.vendor}</span></div><div className="truncate text-xs text-muted">{c.status === "ready" ? `${c.version ?? ""} · ${c.path}${c.method ? ` · via ${c.method}` : ""}` : c.status === "not-installed" ? <>Not installed — <button className="underline" onClick={() => navigator.clipboard?.writeText(c.install).then(() => toast.success("Copied"))}>{c.install}</button></> : (c.detail ?? c.status)}</div>{r && <div className={cn("mt-1 text-xs", r.ok ? "text-ok" : "text-bad")}>{r.ok ? `Test passed in ${(r.ms / 1000).toFixed(1)}s${r.reply ? ` — “${String(r.reply).slice(0, 40)}”` : ""}` : `Test failed: ${r.error}`}</div>}</div>
          {c.status === "ready" && <Button size="xs" variant="secondary" loading={testing === c.id} onClick={() => test(c.id)}>Test</Button>}</li>); })}</ul>
      <p className="border-t border-line px-4 py-2.5 text-xs text-faint">Ready CLIs appear as model providers in AI Studio. They run in a folder you approve, and every command an agent wants to run asks first. “Test” makes one tiny real request (it may use your plan's quota).</p></Card>
  );
}

function Rea() {
  const { bridge, refreshBridge } = useApp(); const [st, setSt] = useState<any>(null); const [plan, setPlan] = useState<any>(null); const [busy, setBusy] = useState(false); const [changes, setChanges] = useState<{ changes: any[]; backups: any[] } | null>(null); const [job, setJob] = useState<any>(null);
  const canUi = bridge?.conn.kind === "ui";
  const load = useCallback(async () => { if (!bridge) return; setBusy(true); try { setSt(await bridge.get("/bridge/rea/status")); setPlan(await bridge.get("/bridge/rea/install-plan")); if (bridge.conn.kind === "ui") setChanges(await bridge.get("/bridge/changes")); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }, [bridge]);
  useEffect(() => { void load(); }, [load]);
  const install = async () => {
    const ok = await requestApproval({ kind: "install", title: "Install REA?", detail: `${plan.steps.filter((s: any) => !s.interactive).map((s: any) => s.description).join(" ")} Existing agent configs are backed up first.`, command: plan.steps.find((s: any) => s.command && !s.interactive)?.command });
    if (!ok) return;
    try { const r = await bridge!.post<{ job?: { id: string } }>("/bridge/rea/install", { approved: true }); toast.success("Installing… this can take a minute"); setJob(r.job ?? null); if (r.job) for (let i = 0; i < 300; i++) { await new Promise((r) => setTimeout(r, 1500)); const l = await bridge!.get<any[]>("/bridge/jobs"); const j = l.find((x) => x.id === r.job!.id); if (j && j.state !== "running") { setJob(j); break; } } await refreshBridge(true); await load(); } catch (e) { toast.error((e as Error).message); }
  };
  const restore = async (dir: string) => { const ok = await requestApproval({ kind: "write", title: "Restore this backup?", detail: `Files saved in ${dir} will be copied back over their current versions.` }); if (!ok) return; try { const r = await bridge!.post<{ restored: string[] }>("/bridge/restore", { dir }); toast.success(`Restored ${r.restored.length} file(s)`); await load(); } catch (e) { toast.error((e as Error).message); } };
  const bad = st && st.status !== "available";
  return (
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><PlugZap className="size-4" />REA — reverse-engineering agent</CardTitle><div className="flex items-center gap-2">{st && <Badge tone={ST[st.status] ?? "neutral"} dot>{st.status === "available" ? `ready · v${st.version}` : st.status.replace(/-/g, " ")}</Badge>}<Button size="icon-sm" variant="ghost" aria-label="Refresh REA status" onClick={load}><RefreshCw className={cn("size-3.5", busy && "animate-spin")} /></Button></div></CardHeader>
      <CardBody className="space-y-5 text-[13px]">
        <p className="text-muted"><a className="text-accent hover:underline" href="https://github.com/morluto/rea" target="_blank" rel="noopener noreferrer">REA</a> inspects JavaScript/Electron apps, .NET, Go, Rust, WASM, SQLite, Mach-O and more, and can drive Hopper/Ghidra. OmniForge calls its real CLI and turns its evidence into investigations — it never fakes output.</p>
        {st?.detail && <p className={cn(bad ? "text-warn" : "text-muted")}>{st.detail}</p>}
        {st?.providers?.length > 0 && <div><p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-faint">Providers</p><div className="grid gap-2 sm:grid-cols-2">{st.providers.map((p: any) => <div key={p.id} className="rounded-lg border border-line p-2.5"><div className="flex items-center justify-between gap-2"><span className="font-medium">{p.name}</span><Badge tone={ST[p.status] ?? "neutral"}>{p.status}</Badge></div><p className="mt-1 text-xs text-muted">{p.availableOperations}/{p.operations} operations available{p.reasons?.length ? ` — ${p.reasons[0]}` : ""}</p></div>)}</div></div>}
        {st?.doctor?.length > 0 && <div><p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-faint">Readiness checks</p><ul className="space-y-1">{st.doctor.map((d: any, i: number) => <li key={i} className="flex gap-2">{d.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-warn" />}<span><span className="font-medium">{d.name}</span>{!d.ok && d.remediation && <span className="text-muted"> — {d.remediation}</span>}</span></li>)}</ul></div>}
        {st?.mcp?.length > 0 && <div><p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-faint">Registered with your AI agents (MCP)</p><div className="flex flex-wrap gap-1.5">{st.mcp.map((m: any) => <Badge key={m.agent} tone={m.registered ? "ok" : "neutral"} title={m.file}>{m.agent}{m.registered ? " ✓" : ""}</Badge>)}</div></div>}

        {plan && <div className="space-y-3 rounded-xl border border-line bg-bg p-4">
          <div className="flex items-center justify-between gap-2"><p className="font-medium">{st?.status === "not-installed" ? "Setup assistant" : "Repair / re-register"}</p>{!canUi && <Badge tone="warn">needs the desktop app window</Badge>}</div>
          <ol className="space-y-2">{plan.steps.map((s: any, i: number) => <li key={s.id} className="flex gap-3"><span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-overlay text-[11px] font-semibold">{i + 1}</span><div className="min-w-0 space-y-1"><p>{s.description}</p>{s.command && <div className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1"><code className="min-w-0 flex-1 truncate text-xs">{s.command}</code><CopyButton text={s.command} label="" /></div>}<p className="text-xs text-faint">Modifies: {s.modifies.join("; ")}{s.interactive ? " · run this one in your own terminal (it asks questions)" : ""}</p></div></li>)}</ol>
          <p className="flex gap-2 text-xs text-muted"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" />{plan.note}</p>
          <div className="flex flex-wrap gap-2">{plan.steps.some((s: any) => !s.interactive) ? <Button variant="primary" disabled={!canUi} onClick={install}>Review & install</Button> : <p className="text-xs text-ok">The REA CLI is installed. Run <code>rea setup</code> in a terminal to register it with your agents.</p>}{job && <Badge tone={job.state === "done" ? "ok" : job.state === "running" ? "info" : "bad"}>install {job.state}</Badge>}</div>
        </div>}

        {canUi && changes && (changes.backups.length > 0 || changes.changes.length > 0) && <div className="space-y-2"><p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-faint"><RotateCcw className="size-3.5" />Changes made to your machine & restore points</p>
          <ul className="divide-y divide-line rounded-lg border border-line">{changes.changes.slice(0, 8).map((c) => <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2"><Badge>{c.action}</Badge><span className="min-w-0 flex-1 truncate">{c.detail}</span><span className="text-xs text-faint">{ago(c.at)}</span>{c.backup && c.action !== "restore" && <Button size="xs" variant="ghost" onClick={() => restore(c.backup)}>Restore</Button>}</li>)}</ul></div>}
      </CardBody></Card>
  );
}

const HC = { pass: <CheckCircle2 className="size-4 text-ok" />, warn: <ShieldAlert className="size-4 text-warn" />, fail: <XCircle className="size-4 text-bad" />, skip: <span className="grid size-4 place-items-center text-faint">–</span> };

/** One button that really probes everything (engine, tools, providers, GitHub, Vercel) and can save the result as a report. */
function SetupCard() {
  const { refreshBridge, bridgeState } = useApp(); const [rows, setRows] = useState<HealthCheck[] | null>(null); const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setRows(await runHealthCheck()); } finally { setBusy(false); } };
  const fails = rows?.filter((r) => r.status === "fail").length ?? 0, warns = rows?.filter((r) => r.status === "warn").length ?? 0;
  const reconnect = async () => { setBusy(true); try { if (bridgeState === "connected") await refreshBridge(true); await refreshModels(); setRows(await runHealthCheck()); toast.success("Reconnected and re-checked"); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  const save = () => { download("omniforge-diagnostics.json", JSON.stringify({ app: "OmniForge RE", at: new Date().toISOString(), ua: navigator.userAgent, checks: rows }, null, 2), "application/json"); void audit("diagnostics report saved"); };
  return (
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Wrench className="size-4" />Setup & diagnostics</CardTitle>
      <div className="flex gap-1.5"><Button size="xs" variant="primary" loading={busy} onClick={run}>{rows ? "Re-run checks" : "Run checks"}</Button>{rows && <><Button size="xs" variant="secondary" icon={<RefreshCw className="size-3.5" />} disabled={busy} onClick={reconnect}>Reconnect</Button><Button size="xs" variant="ghost" onClick={save}>Save report</Button></>}</div></CardHeader>
      {!rows ? <CardBody><p className="text-[13px] text-muted">Tests the local engine, installed tools, AI providers and your GitHub and Vercel tokens — each with a real request, nothing assumed.</p></CardBody>
        : <><ul className="divide-y divide-line" data-testid="health-checks">{rows.map((r) => <li key={r.id} className="flex items-start gap-3 px-4 py-2.5 text-[13px]">{HC[r.status]}<div className="min-w-0"><span className="font-medium">{r.label}</span><span className="text-muted"> — {r.detail}</span>{r.fix && r.status !== "pass" && <div className="text-xs text-faint">Fix: {r.fix}</div>}</div></li>)}</ul>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-xs text-muted"><span>{fails ? `${fails} failing` : "Nothing failing"}{warns ? ` · ${warns} to review` : ""}</span><Link to="/settings" className="text-accent hover:underline">View logs & restore settings →</Link></div></>}
    </Card>
  );
}
