import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Archive, CircleAlert, GitBranch, Play, RefreshCw, RotateCcw, SquareTerminal, StopCircle, TestTube2, TriangleAlert, Info, ExternalLink } from "lucide-react";
import { createSnapshot, diffSnapshots, restoreSnapshot } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { readSSE } from "@/lib/bridge";
import { ago, cn } from "@/lib/utils";
import { Badge, Button, EmptyState, Input, Spinner } from "@/components/ui/primitives";
import type { WorkspaceApi } from "@/lib/workspace";

export interface Marker { path: string; line: number; col: number; severity: "error" | "warning" | "info"; message: string }
const SandpackPreview = lazy(() => import("./SandpackPreview"));

/* ------------------------------ Preview ------------------------------ */
/** Inline local CSS/JS into index.html so the page runs in a sandboxed iframe with no network access to our app. */
export function buildStaticDoc(get: (p: string) => string | undefined): string | null {
  const html = get("index.html"); if (html === undefined) return null;
  const rel = (u: string) => u.replace(/^\.?\//, "").split(/[?#]/)[0]!;
  return html
    .replace(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi, (m, h) => { const css = !/^https?:|^\/\//.test(h) ? get(rel(h)) : undefined; return css !== undefined ? `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>` : m; })
    .replace(/<script([^>]*)\ssrc=["']([^"']+)["']([^>]*)><\/script>/gi, (m, a, s, b) => { const js = !/^https?:|^\/\//.test(s) ? get(rel(s)) : undefined; return js !== undefined ? `<script${a}${b}>${js.replace(/<\/script/gi, "<\\/script")}</script>` : m; });
}

export function PreviewPanel({ ws, devUrl }: { ws: WorkspaceApi; devUrl?: string }) {
  const pkg = ws.get("package.json"); const isReact = !!pkg && /"react"\s*:/.test(pkg);
  const doc = useMemo(() => (isReact ? null : buildStaticDoc(ws.get)), [ws.paths, ws.get, isReact]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nonce, setNonce] = useState(0);
  if (devUrl) return <div className="flex h-full flex-col"><div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-muted"><Badge tone="ok" dot>dev server</Badge><span className="truncate font-mono">{devUrl}</span><a className="ml-auto" href={devUrl} target="_blank" rel="noopener noreferrer" aria-label="Open in a tab"><ExternalLink className="size-3.5" /></a></div><iframe title="Dev server preview" src={devUrl} className="min-h-0 flex-1 bg-white" sandbox="allow-scripts allow-same-origin allow-forms allow-modals" /></div>;
  if (isReact) return <Suspense fallback={<div className="grid h-full place-items-center"><Spinner /></div>}><SandpackPreview paths={ws.paths} get={ws.get} /></Suspense>;
  if (doc !== null) return <div className="flex h-full flex-col"><div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-muted"><span>Static preview — runs in a sandbox with no access to this app</span><Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="Reload preview" onClick={() => setNonce((n) => n + 1)}><RefreshCw className="size-3.5" /></Button></div><iframe key={nonce} title="Preview" srcDoc={doc} className="min-h-0 flex-1 bg-white" sandbox="allow-scripts allow-forms allow-modals" /></div>;
  return <EmptyState icon={<Play className="size-5" />} title="Nothing to preview yet" body="Add an index.html for an instant sandboxed preview, or a React project (package.json) for a live Sandpack preview. On the desktop app you can also run your own dev server." />;
}

/* ------------------------------ Terminal ------------------------------ */
interface Run { id: string; cmd: string; out: string; state: "running" | "done" | "failed" | "cancelled" | "timeout" | "interrupted"; code?: number | null }

export function useRunner(rootId?: string, onDevUrl?: (u: string) => void) {
  const bridge = useApp((s) => s.bridge); const [runs, setRuns] = useState<Run[]>([]);
  const run = useCallback(async (cmd: string) => {
    if (!bridge || !rootId) return; const ctrl = new AbortController();
    const meta = await bridge.post<{ id: string }>("/bridge/jobs", { root: rootId, shell: true, command: cmd, timeoutMs: 1_800_000 });
    setRuns((r) => [{ id: meta.id, cmd, out: "", state: "running" } as Run, ...r].slice(0, 12));
    void (async () => { try { const res = await bridge.raw("GET", `/bridge/jobs/${meta.id}/stream`, undefined, ctrl.signal); await readSSE(res, (ev, d) => { if (ev === "line") { setRuns((r) => r.map((x) => (x.id === meta.id ? { ...x, out: (x.out + d.text + "\n").slice(-60_000) } : x))); const m = String(d.text).match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/); if (m) onDevUrl?.(m[0]!); } else if (ev === "end") setRuns((r) => r.map((x) => (x.id === meta.id ? { ...x, state: d.state as Run["state"], code: d.code } : x))); }); } catch { /* stream closed */ } })();
    return meta.id;
  }, [bridge, rootId, onDevUrl]);
  const cancel = useCallback(async (id: string) => { await bridge?.post(`/bridge/jobs/${id}/cancel`).catch(() => {}); }, [bridge]);
  return { runs, run, cancel };
}

export function TerminalPanel({ runner, disabled }: { runner: ReturnType<typeof useRunner>; disabled?: string }) {
  const [cmd, setCmd] = useState(""); const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [runner.runs[0]?.out]);
  if (disabled) return <EmptyState icon={<SquareTerminal className="size-5" />} title="Terminal needs the desktop app" body={disabled} />;
  return (
    <div className="flex h-full flex-col">
      <form className="flex gap-2 border-b border-line p-2" onSubmit={async (e) => { e.preventDefault(); const c = cmd.trim(); if (!c) return; setCmd(""); try { await runner.run(c); } catch (er) { toast.error((er as Error).message); } }}>
        <span className="grid h-8 place-items-center font-mono text-xs text-faint">$</span><Input className="h-8 font-mono text-xs" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="npm install   ·   npm run dev   ·   npm test" aria-label="Command" spellCheck={false} /><Button type="submit" size="sm" variant="primary" disabled={!cmd.trim()}>Run</Button>
      </form>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 font-mono text-xs">
        {runner.runs.length === 0 && <p className="text-faint">Commands run in your approved folder, with a sanitised environment (your secrets aren't passed in).</p>}
        {runner.runs.map((r) => <div key={r.id} className="space-y-1"><div className="flex items-center gap-2"><span className="text-accent">$ {r.cmd}</span><Badge tone={r.state === "running" ? "info" : r.state === "done" ? "ok" : "bad"}>{r.state === "done" ? "exit 0" : r.state === "failed" ? `exit ${r.code ?? "?"}` : r.state}</Badge>{r.state === "running" && <Button size="icon-sm" variant="ghost" aria-label="Stop command" onClick={() => runner.cancel(r.id)}><StopCircle className="size-3.5" /></Button>}</div><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-muted">{r.out || (r.state === "running" ? "…" : "")}</pre></div>)}
        <div ref={end} />
      </div>
    </div>
  );
}

export function TestsBar({ ws, runner }: { ws: WorkspaceApi; runner: ReturnType<typeof useRunner> }) {
  const scripts = useMemo(() => { try { return JSON.parse(ws.get("package.json") ?? "{}").scripts ?? {}; } catch { return {}; } }, [ws.paths, ws.get]) as Record<string, string>; // eslint-disable-line react-hooks/exhaustive-deps
  const cmds: [string, string][] = [["Install", "npm install"], ...(["build", "test", "lint", "dev"] as const).filter((s) => scripts[s]).map((s) => [s[0]!.toUpperCase() + s.slice(1), s === "test" ? "npm test" : `npm run ${s}`] as [string, string])];
  return <div className="flex flex-wrap gap-1.5 border-b border-line p-2">{cmds.map(([l, c]) => <Button key={c} size="xs" variant="secondary" icon={l === "Test" ? <TestTube2 className="size-3.5" /> : <Play className="size-3.5" />} onClick={() => runner.run(c).catch((e) => toast.error((e as Error).message))}>{l}</Button>)}</div>;
}

/* ------------------------------ Git ------------------------------ */
export function GitPanel({ rootId }: { rootId?: string }) {
  const bridge = useApp((s) => s.bridge);
  const [st, setSt] = useState<{ isRepo: boolean; branch?: string; changes?: { status: string; path: string }[] } | null>(null); const [log, setLog] = useState<{ sha: string; subject: string; author: string; date: string }[]>([]);
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { if (!bridge || !rootId) return; try { const s = await bridge.post<any>("/bridge/git/status", { root: rootId }); setSt(s); if (s.isRepo) setLog(await bridge.post("/bridge/git/log", { root: rootId }).catch(() => [])); } catch (e) { toast.error((e as Error).message); } }, [bridge, rootId]);
  useEffect(() => { void load(); }, [load]);
  if (!rootId) return <EmptyState icon={<GitBranch className="size-5" />} title="Git needs a local folder" body="Switch the workspace to a folder on your Mac (desktop app) to see changes, diffs and commit." />;
  if (!st) return <div className="grid h-full place-items-center"><Spinner /></div>;
  if (!st.isRepo) return <EmptyState icon={<GitBranch className="size-5" />} title="Not a git repository" body="Initialise one to track changes and commit." action={<Button variant="primary" onClick={async () => { await bridge!.post("/bridge/git/init", { root: rootId }).catch((e) => toast.error(e.message)); await load(); }}>git init</Button>} />;
  const act = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); await load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  return (
    <div className="flex h-full min-h-0 flex-col text-[13px]">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2"><GitBranch className="size-4 text-muted" /><span className="font-medium">{st.branch}</span><Badge>{st.changes?.length ?? 0} changed</Badge><Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="Refresh git status" onClick={load}><RefreshCw className="size-3.5" /></Button></div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {st.changes?.length ? <ul className="divide-y divide-line">{st.changes.map((c) => <li key={c.path}><button className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-elevated" onClick={async () => setDiff({ path: c.path, text: (await bridge!.post<{ diff: string }>("/bridge/git/diff", { root: rootId, file: c.path })).diff || "(untracked or binary file — no diff)" })}><Badge tone={c.status === "M" ? "warn" : c.status === "D" ? "bad" : "ok"}>{c.status}</Badge><span className="truncate font-mono text-xs">{c.path}</span></button></li>)}</ul> : <p className="p-3 text-muted">Working tree clean.</p>}
        {diff && <div className="border-t border-line"><div className="flex items-center justify-between px-3 py-1.5 text-xs text-muted"><span className="font-mono">{diff.path}</span><button onClick={() => setDiff(null)}>close</button></div><pre className="max-h-56 overflow-auto bg-bg p-3 font-mono text-[11px] leading-relaxed">{diff.text.split("\n").map((l, i) => <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "bg-ok/10 text-ok" : l.startsWith("-") && !l.startsWith("---") ? "bg-bad/10 text-bad" : l.startsWith("@@") ? "text-info" : "text-muted"}>{l || " "}</div>)}</pre></div>}
        {log.length > 0 && <div className="border-t border-line"><p className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">History</p><ul className="divide-y divide-line">{log.slice(0, 8).map((l) => <li key={l.sha} className="flex items-center gap-2 px-3 py-1.5"><code className="text-xs text-accent">{l.sha.slice(0, 7)}</code><span className="min-w-0 flex-1 truncate">{l.subject}</span><span className="text-xs text-faint">{ago(l.date)}</span></li>)}</ul></div>}
      </div>
      <form className="flex gap-2 border-t border-line p-2" onSubmit={(e) => { e.preventDefault(); void act(async () => { const r = await bridge!.post<{ ok: boolean; message?: string; sha?: string; excluded?: string[] }>("/bridge/git/commit", { root: rootId, message: msg || "Update" }); r.ok ? toast.success(`Committed ${r.sha?.slice(0, 7)}`, { description: r.excluded?.length ? `Left out (look like secrets): ${r.excluded.join(", ")}` : undefined }) : toast.error(r.message ?? "Commit failed"); setMsg(""); }); }}><Input className="h-8 text-xs" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Commit message" aria-label="Commit message" /><Button type="submit" size="sm" variant="primary" loading={busy} disabled={!st.changes?.length}>Commit all</Button></form>
    </div>
  );
}

/* ------------------------------ Problems ------------------------------ */
export function ProblemsPanel({ markers, onJump }: { markers: Marker[]; onJump: (m: Marker) => void }) {
  if (!markers.length) return <EmptyState icon={<CircleAlert className="size-5" />} title="No problems" body="Syntax and type diagnostics for the open file appear here. Missing node_modules types aren't reported (they can't be resolved in the browser)." />;
  return <ul className="divide-y divide-line text-[13px]">{markers.map((m, i) => <li key={i}><button className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-elevated" onClick={() => onJump(m)}>{m.severity === "error" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" /> : m.severity === "warning" ? <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" /> : <Info className="mt-0.5 size-4 shrink-0 text-info" />}<span className="min-w-0"><span className="block break-words">{m.message}</span><span className="font-mono text-xs text-faint">{m.path}:{m.line}:{m.col}</span></span></button></li>)}</ul>;
}

/* ------------------------------ History (checkpoints) ------------------------------ */
export function HistoryPanel({ ws, onCompare, compare }: { ws: WorkspaceApi; onCompare: (id: string | null) => void; compare: string | null }) {
  const { project, mutate } = useApp(); const [label, setLabel] = useState("");
  if (ws.kind !== "browser") return <EmptyState icon={<Archive className="size-5" />} title="Use git for local folders" body="Checkpoints snapshot the in-browser project. For a folder on your Mac, commit with the Git tab." />;
  const snaps = project?.snapshots ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col text-[13px]">
      <form className="flex gap-2 border-b border-line p-2" onSubmit={(e) => { e.preventDefault(); mutate((p) => createSnapshot(p, label.trim() || `Checkpoint ${new Date().toLocaleTimeString()}`).project); setLabel(""); toast.success("Checkpoint saved"); }}><Input className="h-8 text-xs" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Checkpoint label" aria-label="Checkpoint label" /><Button type="submit" size="sm" variant="secondary" disabled={!ws.paths.length}>Save</Button></form>
      <div className="min-h-0 flex-1 overflow-y-auto">{snaps.length === 0 ? <p className="p-3 text-muted">No checkpoints yet.</p> : <ul className="divide-y divide-line">{snaps.map((s) => { const d = diffSnapshots(s.files, project!.workspace.files); return <li key={s.id} className="space-y-1 px-3 py-2"><div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{s.label}</span><span className="text-xs text-faint">{ago(s.at)}</span></div><div className="flex items-center gap-1.5 text-xs text-muted"><Badge tone="ok">+{d.added.length}</Badge><Badge tone="warn">~{d.changed.length}</Badge><Badge tone="bad">−{d.removed.length}</Badge><Button size="xs" variant={compare === s.id ? "soft" : "ghost"} className="ml-auto" onClick={() => onCompare(compare === s.id ? null : s.id)}>{compare === s.id ? "Hide diff" : "Diff"}</Button><Button size="xs" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => { mutate((p) => restoreSnapshot(p, s.id)); toast.success("Restored (previous state was checkpointed automatically)"); }}>Restore</Button></div></li>; })}</ul>}</div>
    </div>
  );
}
