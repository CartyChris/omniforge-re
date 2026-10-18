import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, FilePlus2, FileX2, Loader2, PencilLine, RotateCcw, SquareTerminal, StopCircle, Terminal, TriangleAlert } from "lucide-react";
import { useSearchParams } from "react-router";
import { MCP_PRESETS, REBUILD_MODES, claudeAgentArgs, commandRuleProblem, describeMcpServer, mcpServerProblem, rebuildInstruction, siteBrief, type McpServerSpec, type RebuildMode, type AgentEvent, type Investigation } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { readSSE } from "@/lib/bridge";
import { listRoots, type RootInfo } from "@/lib/local";
import { requestApproval } from "@/lib/approvals";
import { audit } from "@/lib/audit";
import { db } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, Field, Input, Spinner, Textarea } from "@/components/ui/primitives";
import { Select } from "@/components/ui/overlay";

const LazyDiff = lazy(async () => { await import("@/lib/monaco"); const m = await import("@/components/workspace/Editor"); return { default: m.DiffView }; });

interface Change { path: string; status: "added" | "modified" | "deleted"; additions: number; deletions: number; binary: boolean; refused?: string }
interface Start { runId: string; copied: number; bytes: number; skipped: { path: string; reason: string }[]; cli?: string }
interface Done { runId: string; ok: boolean; result?: Extract<AgentEvent, { type: "result" }>; changes: Change[] }
const PRESETS = ["npm test", "npm run build", "pytest -q", "go test ./...", "cargo test"];
const ICON = { added: <FilePlus2 className="size-3.5 text-ok" />, modified: <PencilLine className="size-3.5 text-warn" />, deleted: <FileX2 className="size-3.5 text-bad" /> };

/** Let the user's installed Claude Code edit an ISOLATED COPY of an approved folder. Nothing reaches the folder until the diff has been reviewed and applied. */
export function CliAgentPanel() {
  const { bridge, bridgeState, bridgeInfo, project, settings } = useApp();
  const cli = bridgeInfo?.clis.find((c: { id: string }) => c.id === "claude-code") as { status: string; version?: string } | undefined;
  const invs = ((project?.investigations ?? []) as unknown as Investigation[]).filter((i) => i.status === "done");
  const [params] = useSearchParams();
  // "Rebuild with Claude Code" arrives as ?inv=&mode=&stack=[&features=a,b][&improve=…]: pre-fill the analysis and the instruction (still editable, still behind the consent dialog).
  const [roots, setRoots] = useState<RootInfo[]>([]); const [root, setRoot] = useState(""); const [prompt, setPrompt] = useState(""); const [inv, setInv] = useState("none");
  const [cmds, setCmds] = useState<string[]>([]); const [cmdText, setCmdText] = useState("");
  // MCP servers the user has defined (kept on this device) and which of them this run may use. Nothing is selected by default.
  const [mcpDefs, setMcpDefs] = useState<McpServerSpec[]>([]); const [mcpOn, setMcpOn] = useState<Set<string>>(new Set()); const [mcpForm, setMcpForm] = useState({ name: "", target: "" });
  useEffect(() => { void db.get<McpServerSpec[]>("agent:mcp").then((d) => Array.isArray(d) && setMcpDefs(d.filter((x) => !mcpServerProblem(x)))).catch(() => {}); }, []);
  const saveDefs = (d: McpServerSpec[]) => { setMcpDefs(d); void db.set("agent:mcp", d).catch(() => {}); };
  const [busy, setBusy] = useState(false); const [events, setEvents] = useState<AgentEvent[]>([]); const [start, setStart] = useState<Start | null>(null); const [done, setDone] = useState<Done | null>(null); const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set()); const [allowDeletes, setAllowDeletes] = useState(false); const [view, setView] = useState<string | null>(null); const [sides, setSides] = useState<{ base: string | null; next: string | null; binary: boolean } | null>(null);
  const [applied, setApplied] = useState<{ applied: string[]; conflicts: { path: string; reason: string }[]; refused: { path: string; reason: string }[]; backup: string | null } | null>(null);
  const abort = useRef<AbortController | null>(null); const feed = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);
  useEffect(() => { // the project may hydrate after first render, so seed once as soon as the analysis exists
    if (seeded.current) return; const id = params.get("inv"); const mode = params.get("mode") as RebuildMode | null; if (!id || !mode) { seeded.current = true; return; }
    const found = invs.find((i) => i.id === id); if (!found) return; seeded.current = true;
    if (!REBUILD_MODES.some((m) => m.id === mode)) return;
    setInv(found.id); setPrompt(rebuildInstruction({ inv: found, mode, stackId: params.get("stack") ?? "react-vite", featureIds: params.get("features")?.split(",").filter(Boolean), improvements: params.get("improve") ?? undefined }));
  }, [invs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (bridgeState === "connected") void listRoots().then((r) => { setRoots(r); if (!root && r[0]) setRoot(r[0].id); }).catch(() => {}); }, [bridgeState]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { feed.current?.scrollTo({ top: feed.current.scrollHeight }); }, [events.length]);
  useEffect(() => { if (!view || !done || !bridge) { setSides(null); return; } let on = true; void bridge.get(`/bridge/agent/runs/${done.runId}/file?path=${encodeURIComponent(view)}`).then((s) => on && setSides(s as typeof sides)).catch(() => on && setSides(null)); return () => { on = false; }; }, [view, done, bridge]);
  const rootInfo = roots.find((r) => r.id === root);
  const cmdProblems = useMemo(() => cmds.map((c) => commandRuleProblem(c)).filter(Boolean), [cmds]);

  if (bridgeState !== "connected" || !bridge) return <Card><EmptyState icon={<Terminal className="size-5" />} title="Needs the macOS app" body="Agent mode runs your installed coding CLI on this Mac, on a private copy of a folder you approved. Install and open the desktop app to use it." /></Card>;
  if (!cli || cli.status === "not-installed") return <Card><EmptyState icon={<Terminal className="size-5" />} title="Claude Code isn't installed" body="Install it (npm install -g @anthropic-ai/claude-code) and sign in once in a terminal, then reopen this tab. Other CLIs are used as text providers in Chat and Build." /></Card>;

  const addCmd = (c: string) => { const t = c.trim(); if (!t || cmds.includes(t)) return; const p = commandRuleProblem(t); if (p) return void toast.error(p); setCmds([...cmds, t]); setCmdText(""); };
  const mcpAll: McpServerSpec[] = [...MCP_PRESETS.map((p) => p.server), ...mcpDefs.filter((d) => !MCP_PRESETS.some((p) => p.server.name === d.name))];
  const mcpChosen = mcpAll.filter((m) => mcpOn.has(m.name));
  const addMcp = () => {
    const name = mcpForm.name.trim(); const t = mcpForm.target.trim(); if (!name || !t) return;
    const spec: McpServerSpec = /^https?:\/\//i.test(t) ? { name, url: t } : { name, command: t.split(/\s+/)[0]!, args: t.split(/\s+/).slice(1) };
    const p = mcpServerProblem(spec); if (p) return void toast.error(p);
    if (mcpAll.some((m) => m.name === name)) return void toast.error("A server with that name already exists.");
    saveDefs([...mcpDefs, spec]); setMcpOn(new Set([...mcpOn, name])); setMcpForm({ name: "", target: "" });
  };
  const run = async () => {
    if (!rootInfo || !prompt.trim()) return;
    const shown = claudeAgentArgs({ allowedCommands: cmds, mcpServers: mcpChosen, mcpConfigPath: "<private config file>" }).filter((_, i, a) => a[i - 1] !== "--append-system-prompt" && a[i] !== "--append-system-prompt");
    const ok = await requestApproval({ kind: "command", title: `Run Claude Code on a copy of “${rootInfo.label}”?`, detail: `Claude Code ${cli.version ?? ""} will read and edit a private copy of this folder (without credential files, dependencies or any .claude / CLAUDE.md configuration). Your folder is not touched until you review and apply the changes. It uses your own Claude login and may cost credits (capped at $2 for this run).${cmds.length ? ` It may also run these commands inside the copy: ${cmds.join(", ")}.` : " It cannot run shell commands."}${mcpChosen.length ? ` It may use these MCP servers, which are programs or services outside this app that act with your permissions and are not sandboxed: ${mcpChosen.map(describeMcpServer).join(" · ")}.` : ""}`, command: `claude ${shown.join(" ")}${mcpChosen.length ? `\n# MCP config: ${JSON.stringify(Object.fromEntries(mcpChosen.map((m) => [m.name, "url" in m ? { type: "http", url: m.url } : { command: m.command, args: m.args }])))}` : ""}`, danger: cmds.length > 0 || mcpChosen.length > 0 });
    if (!ok) return;
    const brief = inv !== "none" ? siteBrief(invs.find((i) => i.id === inv)!) : undefined;
    setBusy(true); setEvents([]); setStart(null); setDone(null); setError(null); setApplied(null); setPicked(new Set()); setView(null); const ctrl = new AbortController(); abort.current = ctrl;
    void audit("agent run started", `Claude Code on ${rootInfo.label}${cmds.length ? ` with commands: ${cmds.join(", ")}` : ""}${mcpChosen.length ? ` with MCP servers: ${mcpChosen.map((m) => m.name).join(", ")}` : ""}`);
    try {
      const res = await bridge.raw("POST", "/bridge/agent/run", { cli: "claude-code", root, prompt: prompt.trim(), brief, allowedCommands: cmds, mcpServers: mcpChosen, maxBudgetUsd: 2 }, ctrl.signal);
      await readSSE(res, (ev, d) => {
        if (ev === "start") setStart(d); else if (ev === "event") setEvents((e) => [...e, d]);
        else if (ev === "done") { setDone(d); setPicked(new Set((d.changes as Change[]).filter((c) => !c.refused && c.status !== "deleted").map((c) => c.path))); setView((d.changes as Change[])[0]?.path ?? null); }
        else if (ev === "error") setError(d.message);
      }, ctrl.signal);
    } catch (e) { if ((e as Error).name !== "AbortError") setError((e as Error).message); }
    finally { setBusy(false); abort.current = null; }
  };
  const apply = async () => {
    if (!done) return; setBusy(true);
    try { const r = await bridge.post<NonNullable<typeof applied>>(`/bridge/agent/runs/${done.runId}/apply`, { paths: [...picked], allowDeletes }); setApplied(r); void audit("agent changes applied", `${r.applied.length} file(s) into ${rootInfo?.label}`); r.applied.length ? toast.success(`Applied ${r.applied.length} file(s)`) : toast.warning("Nothing was applied — see the details below"); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const discard = async () => { if (done) await bridge.json("DELETE", `/bridge/agent/runs/${done.runId}`).catch(() => {}); setDone(null); setStart(null); setEvents([]); setApplied(null); setView(null); };
  const undo = async () => { if (!applied?.backup) return; try { await bridge.post("/bridge/restore", { dir: applied.backup }); void audit("agent apply undone", rootInfo?.label ?? ""); toast.success("Restored the files that were overwritten"); setApplied(null); } catch (e) { toast.error((e as Error).message); } };
  const changes = done?.changes ?? []; const sel = changes.filter((c) => picked.has(c.path));

  return (
    <div className="space-y-5">
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><SquareTerminal className="size-4" />Claude Code, on a private copy</CardTitle><Badge tone={cli.status === "ready" ? "ok" : "warn"} dot>{cli.status === "ready" ? `v${cli.version ?? "?"}` : cli.status.replace(/-/g, " ")}</Badge></CardHeader>
        <CardBody className="space-y-4">
          <p className="text-[13px] text-muted">Your installed Claude Code edits a copy of the folder, so you see exactly what it changed before anything reaches your project. {settings.localOnly && <span className="text-warn">Local-only mode is on — Claude Code sends your code to Anthropic, so it is disabled.</span>}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project folder (approved)" group><Select label="Project folder" value={root} onValueChange={setRoot} options={roots.map((r) => ({ value: r.id, label: r.label, hint: r.writable ? "writable" : "read-only" }))} placeholder="Approve a folder in Analyze first" /></Field>
            <Field label="Use an analysis as background (optional)" group><Select label="Background analysis" value={inv} onValueChange={setInv} options={[{ value: "none", label: "None" }, ...invs.map((i) => ({ value: i.id, label: i.name }))]} /></Field>
          </div>
          <Field label="What should it do?"><Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="e.g. Add a dark-mode toggle to the header and persist the choice in localStorage" aria-label="What should the agent do" /></Field>
          <details className="text-[13px]"><summary className="cursor-pointer text-muted hover:text-fg">Allow it to run commands (off by default){cmds.length ? ` — ${cmds.length} allowed` : ""}</summary>
            <div className="mt-2 space-y-2"><p className="text-xs text-muted">Commands run inside the copy as you, not in a sandbox. Only these exact commands (and their arguments) are permitted; everything else is denied.</p>
              <div className="flex flex-wrap gap-1.5">{PRESETS.map((p) => <Button key={p} size="xs" variant={cmds.includes(p) ? "primary" : "secondary"} onClick={() => setCmds(cmds.includes(p) ? cmds.filter((x) => x !== p) : [...cmds, p])}>{p}</Button>)}</div>
              <div className="flex gap-2"><Input value={cmdText} onChange={(e) => setCmdText(e.target.value)} placeholder="another command, e.g. make check" aria-label="Add an allowed command" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCmd(cmdText); } }} /><Button size="sm" variant="secondary" onClick={() => addCmd(cmdText)}>Add</Button></div>
              {cmds.filter((c) => !PRESETS.includes(c)).map((c) => <Badge key={c} tone="warn">{c}</Badge>)}
            </div></details>
          <details className="text-[13px]"><summary className="cursor-pointer text-muted hover:text-fg">Give it MCP tools (off by default){mcpChosen.length ? ` — ${mcpChosen.length} selected` : ""}</summary>
            <div className="mt-2 space-y-2"><p className="text-xs text-muted">MCP servers add tools such as a browser, live docs or your own services. A server is a program that runs on this Mac as you (not sandboxed) or a web service that receives what the agent sends it, so choose only ones you trust. Presets are pinned to an exact version.</p>
              <div className="space-y-1.5">{mcpAll.map((m) => { const preset = MCP_PRESETS.find((p) => p.server.name === m.name); return (
                <label key={m.name} className="flex items-start gap-2 rounded-lg border border-line px-2.5 py-2"><input type="checkbox" className="mt-0.5" checked={mcpOn.has(m.name)} onChange={(e) => setMcpOn((p) => { const n = new Set(p); e.target.checked ? n.add(m.name) : n.delete(m.name); return n; })} aria-label={`Use MCP server ${m.name}`} />
                  <span className="min-w-0 flex-1"><span className="font-medium">{preset?.label ?? m.name}</span>{preset && <span className="text-muted"> — {preset.blurb}</span>}<span className="mt-0.5 block truncate font-mono text-[11px] text-muted" title={describeMcpServer(m)}>{describeMcpServer(m).replace(/^[^:]+: /, "")}</span>{preset && <span className="block text-[11px] text-warn">{preset.leaves}</span>}</span>
                  {!preset && <Button size="xs" variant="ghost" onClick={(e) => { e.preventDefault(); saveDefs(mcpDefs.filter((d) => d.name !== m.name)); setMcpOn((p) => { const n = new Set(p); n.delete(m.name); return n; }); }}>Remove</Button>}</label>); })}</div>
              <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]"><Input value={mcpForm.name} onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })} placeholder="name, e.g. my-docs" aria-label="MCP server name" /><Input value={mcpForm.target} onChange={(e) => setMcpForm({ ...mcpForm, target: e.target.value })} placeholder="command and arguments, or an https:// address" aria-label="MCP server command or address" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addMcp(); } }} /><Button size="sm" variant="secondary" onClick={addMcp}>Add</Button></div>
            </div></details>
          <div className="flex items-center gap-2">{busy && !done ? <Button variant="danger" icon={<StopCircle className="size-4" />} onClick={() => abort.current?.abort()}>Stop</Button> : <Button variant="primary" icon={<Terminal className="size-4" />} disabled={busy || !rootInfo || !prompt.trim() || !!cmdProblems.length || settings.localOnly || cli.status === "installed-unauthenticated"} onClick={() => void run()}>Run on a copy</Button>}
            {cli.status === "installed-unauthenticated" && <span className="text-xs text-warn">Sign in to Claude Code in a terminal first.</span>}</div>
        </CardBody></Card>

      {(start || events.length > 0 || error) && <Card><CardHeader><CardTitle>Progress</CardTitle>{start && <span className="text-xs text-muted">copied {start.copied} files ({(start.bytes / 1e6).toFixed(1)} MB){start.skipped.length ? `, left out ${start.skipped.length}` : ""}</span>}{busy && !done && <Loader2 className="size-4 animate-spin text-accent" />}</CardHeader>
        <div ref={feed} className="max-h-72 space-y-1 overflow-auto p-3 text-[13px]" role="log" aria-live="polite" data-testid="agent-feed">
          {events.map((e, i) => e.type === "text" ? <p key={i} className="whitespace-pre-wrap">{e.text}</p> : e.type === "tool" ? <p key={i} className="font-mono text-xs text-muted">▸ {e.summary}</p> : e.type === "tool_result" && !e.ok ? <p key={i} className="font-mono text-xs text-warn">✗ {e.summary}</p> : e.type === "result" ? <p key={i} className={cn("pt-1 text-xs", e.ok ? "text-ok" : "text-bad")}>{e.ok ? "Finished" : "Stopped"}{e.turns ? ` in ${e.turns} turns` : ""}{e.costUsd !== undefined ? ` · $${e.costUsd.toFixed(3)}` : ""}</p> : e.type === "error" ? <p key={i} role="alert" className="text-bad">{e.message}</p> : null)}
          {error && <p role="alert" className="text-bad">{error}</p>}
        </div>
        {start && start.skipped.length > 0 && <details className="border-t border-line px-3 py-2 text-xs text-muted"><summary className="cursor-pointer">Left out of the copy ({start.skipped.length})</summary><ul className="mt-1 max-h-32 overflow-auto font-mono">{start.skipped.map((s) => <li key={s.path}>{s.path} — {s.reason}</li>)}</ul></details>}
      </Card>}

      {done && <Card><CardHeader><CardTitle>Review changes</CardTitle><div className="flex items-center gap-2"><span className="text-xs text-muted">{changes.length} file(s)</span><Button size="xs" variant="ghost" onClick={() => void discard()}>Discard</Button></div></CardHeader>
        {changes.length === 0 ? <CardBody><p className="text-[13px] text-muted">{done.ok ? "The agent finished without changing any file." : "The run did not finish and changed nothing."}</p></CardBody> : <>
          <div className="grid gap-0 lg:grid-cols-[minmax(0,20rem)_1fr]">
            <ul className="max-h-96 divide-y divide-line overflow-auto border-r border-line" data-testid="agent-changes">{changes.map((c) => (
              <li key={c.path} className={cn("flex items-center gap-2 px-3 py-2 text-[13px]", view === c.path && "bg-elevated")}>
                <input type="checkbox" aria-label={`Apply ${c.path}`} checked={picked.has(c.path)} disabled={!!c.refused || (c.status === "deleted" && !allowDeletes)} onChange={(e) => setPicked((p) => { const n = new Set(p); e.target.checked ? n.add(c.path) : n.delete(c.path); return n; })} />
                <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setView(c.path)}>{ICON[c.status]}<span className="truncate font-mono text-xs" title={c.path}>{c.path}</span></button>
                {c.refused ? <Badge tone="bad" title={c.refused}>blocked</Badge> : <span className="shrink-0 text-[11px] tabular-nums text-muted">{c.binary ? "binary" : `+${c.additions} −${c.deletions}`}</span>}
              </li>))}</ul>
            <div className="h-96 min-w-0 bg-bg">{view && sides && !sides.binary ? <Suspense fallback={<div className="grid h-full place-items-center"><Spinner /></div>}><LazyDiff key={view} path={view} original={sides.base ?? ""} modified={sides.next ?? ""} /></Suspense> : <div className="grid h-full place-items-center p-4 text-center text-sm text-muted">{view ? (sides?.binary ? "Binary file — not shown." : "Loading…") : "Select a file to see its changes."}</div>}</div>
          </div>
          {changes.some((c) => c.refused) && <p className="flex items-start gap-1.5 border-t border-line px-4 py-2 text-xs text-warn"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />Some files are blocked and can never be applied: {[...new Set(changes.filter((c) => c.refused).map((c) => c.refused))].join("; ")}.</p>}
          <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
            {changes.some((c) => c.status === "deleted") && <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={allowDeletes} onChange={(e) => { setAllowDeletes(e.target.checked); if (!e.target.checked) setPicked((p) => new Set([...p].filter((x) => changes.find((c) => c.path === x)?.status !== "deleted"))); }} />allow deleting files</label>}
            <Button variant="primary" icon={<Check className="size-4" />} loading={busy} disabled={!sel.length || !rootInfo?.writable} onClick={() => void apply()}>Apply {sel.length} file{sel.length === 1 ? "" : "s"} to the project</Button>
            {!rootInfo?.writable && <span className="text-xs text-warn">This folder is read-only — approve it as writable in Analyze to apply.</span>}
          </div></>}
        {applied && <div className="space-y-1.5 border-t border-line px-4 py-3 text-[13px]" data-testid="agent-applied">
          <p><b>{applied.applied.length}</b> file(s) applied.{applied.backup && <Button size="xs" variant="ghost" className="ml-2" icon={<RotateCcw className="size-3.5" />} onClick={() => void undo()}>Undo</Button>}</p>
          {applied.conflicts.map((c) => <p key={c.path} className="text-warn">Not applied: {c.path} — {c.reason}</p>)}{applied.refused.map((c) => <p key={c.path} className="text-bad">Blocked: {c.path} — {c.reason}</p>)}
        </div>}
      </Card>}
    </div>
  );
}
