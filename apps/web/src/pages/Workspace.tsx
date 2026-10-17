import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Archive, CheckCircle2, CircleAlert, CodeXml, Download, FolderGit2, GitBranch, Loader2, MonitorPlay, Rocket, SquareTerminal, X } from "lucide-react";
import { zipPackage } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { listRoots, type RootInfo } from "@/lib/local";
import { useWorkspace, type Source } from "@/lib/workspace";
import { cn, download } from "@/lib/utils";
import { Badge, Button, EmptyState, Segmented, Spinner } from "@/components/ui/primitives";
import { Select } from "@/components/ui/overlay";
import { FileTree } from "@/components/workspace/FileTree";
import { GitPanel, HistoryPanel, PreviewPanel, ProblemsPanel, TerminalPanel, TestsBar, useRunner, type Marker } from "@/components/workspace/Panels";

const LazyEditor = lazy(async () => { await import("@/lib/monaco"); const m = await import("@/components/workspace/Editor"); return { default: m.CodeEditor }; });
const LazyDiff = lazy(async () => { await import("@/lib/monaco"); const m = await import("@/components/workspace/Editor"); return { default: m.DiffView }; });

type PanelId = "preview" | "terminal" | "git" | "problems" | "history";

export default function Workspace() {
  const { project, bridge, bridgeState } = useApp(); const nav = useNavigate();
  const desktop = bridgeState === "connected" && !!bridge;
  const [roots, setRoots] = useState<RootInfo[]>([]); const [src, setSrc] = useState<Source>({ kind: "browser" });
  useEffect(() => { if (desktop) void listRoots().then((r) => setRoots(r.filter((x) => x.writable))).catch(() => {}); }, [desktop]);
  const ws = useWorkspace(src);
  const [open, setOpen] = useState<string[]>(() => project?.workspace.open ?? []); const [active, setActive] = useState<string | undefined>(project?.workspace.active);
  const [panel, setPanel] = useState<PanelId>("preview"); const [mobile, setMobile] = useState<"files" | "editor" | "panel">("editor");
  const [markers, setMarkers] = useState<Marker[]>([]); const [compare, setCompare] = useState<string | null>(null); const [devUrl, setDevUrl] = useState<string>();
  const runner = useRunner(ws.rootId, setDevUrl);
  const editorRef = useRef<HTMLDivElement>(null);
  // switching source resets tabs
  useEffect(() => { if (src.kind === "local") { setOpen([]); setActive(undefined); setDevUrl(undefined); } else { setOpen(project?.workspace.open ?? []); setActive(project?.workspace.active); } }, [src.kind, src.kind === "local" ? src.rootId : ""]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (src.kind === "browser") useApp.getState().mutate((p) => (p.workspace.active === active && JSON.stringify(p.workspace.open) === JSON.stringify(open) ? p : { ...p, workspace: { ...p.workspace, open, active } })); }, [open, active]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFile = useCallback((p: string) => { setOpen((o) => (o.includes(p) ? o : [...o, p])); setActive(p); setCompare(null); setMobile("editor"); }, []);
  const closeFile = useCallback((p: string) => { setOpen((o) => { const n = o.filter((x) => x !== p); setActive((a) => (a === p ? n[n.length - 1] : a)); return n; }); }, []);
  const snap = compare ? project?.snapshots.find((s) => s.id === compare) : undefined;
  const current = active ? ws.get(active) : undefined;
  const fileMarkers = useMemo(() => markers.filter((m) => m.path === active), [markers, active]);
  const errs = fileMarkers.filter((m) => m.severity === "error").length;
  // keyboard: Ctrl/Cmd-W closes the tab
  useEffect(() => { const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w" && active && document.activeElement?.closest("[data-editor]")) { e.preventDefault(); closeFile(active); } }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [active, closeFile]);

  const isEmpty = ws.paths.length === 0 && !ws.loading;
  const panels: { id: PanelId; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: "preview", label: "Preview", icon: <MonitorPlay className="size-3.5" /> },
    { id: "terminal", label: "Terminal", icon: <SquareTerminal className="size-3.5" />, badge: runner.runs.filter((r) => r.state === "running").length || undefined },
    { id: "git", label: "Git", icon: <GitBranch className="size-3.5" /> },
    { id: "problems", label: "Problems", icon: <CircleAlert className="size-3.5" />, badge: markers.filter((m) => m.severity === "error").length || undefined },
    { id: "history", label: "History", icon: <Archive className="size-3.5" /> },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface/60 px-3 py-2">
        <CodeXml className="size-4 text-muted" />
        <div className="w-48 max-w-full"><Select label="Workspace source" value={src.kind === "local" ? `local:${src.rootId}` : "browser"} onValueChange={(v) => { if (v === "browser") setSrc({ kind: "browser" }); else { const r = roots.find((x) => `local:${x.id}` === v); if (r) setSrc({ kind: "local", rootId: r.id, label: r.label }); } }} options={[{ value: "browser", label: `${project?.name ?? "Project"} (browser)` }, ...roots.map((r) => ({ value: `local:${r.id}`, label: `${r.label} (on this Mac)` }))]} /></div>
        <span className={cn("flex items-center gap-1.5 text-xs", ws.status === "error" ? "text-bad" : "text-muted")}>{ws.status === "saving" ? <><Loader2 className="size-3.5 animate-spin" />Saving…</> : ws.status === "error" ? <><CircleAlert className="size-3.5" />{ws.error ?? "Save failed"}</> : <><CheckCircle2 className="size-3.5 text-ok" />{ws.kind === "local" ? "Saved to disk" : "Saved"}</>}</span>
        {src.kind === "local" && <Badge tone="warn" title="Edits are written to the real folder">live folder</Badge>}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" aria-label="Download ZIP" icon={<Download className="size-4" />} disabled={!ws.paths.length} onClick={() => { download(`${ws.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.zip`, zipPackage(new Map(ws.paths.map((p) => [p, new TextEncoder().encode(ws.get(p) ?? "")]))), "application/zip"); }}><span className="hidden sm:inline">ZIP</span></Button>
          <Button size="sm" variant="secondary" aria-label="Deploy" icon={<Rocket className="size-4" />} onClick={() => nav("/deployments")}><span className="hidden sm:inline">Deploy</span></Button>
        </div>
      </div>
      {ws.error && ws.kind === "local" && !ws.loading && ws.status !== "error" && <div role="alert" className="border-b border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">{ws.error}</div>}

      {/* mobile section switcher */}
      <div className="border-b border-line p-2 lg:hidden"><Segmented size="sm" value={mobile} onChange={setMobile} options={[{ value: "files", label: "Files" }, { value: "editor", label: "Editor" }, { value: "panel", label: "Panels" }]} className="w-full [&>button]:flex-1" /></div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[15rem_minmax(0,1fr)_minmax(18rem,28rem)]">
        <aside className={cn("min-h-0 border-r border-line", mobile === "files" ? "block" : "hidden lg:block")}><FileTree ws={ws} active={active} onOpen={openFile} onClosed={closeFile} /></aside>

        <section className={cn("flex min-h-0 min-w-0 flex-col", mobile === "editor" ? "flex" : "hidden lg:flex")} data-editor>
          <div className="flex items-center overflow-x-auto border-b border-line [scrollbar-width:none]" role="tablist" aria-label="Open files">
            {open.map((p) => <div key={p} role="tab" aria-selected={p === active} className={cn("group flex h-9 shrink-0 cursor-pointer items-center gap-2 border-r border-line px-3 text-[13px]", p === active ? "bg-bg text-fg" : "text-muted hover:text-fg")} onClick={() => { setActive(p); setCompare(null); }}><span className="max-w-[10rem] truncate" title={p}>{p.split("/").pop()}</span><button aria-label={`Close ${p}`} className="rounded p-0.5 text-faint hover:bg-overlay hover:text-fg" onClick={(e) => { e.stopPropagation(); closeFile(p); }}><X className="size-3.5" /></button></div>)}
            {active && snap && <Badge tone="accent" className="ml-2">diff vs “{snap.label}”</Badge>}
            {active && errs > 0 && <Badge tone="bad" className="ml-2">{errs} error{errs > 1 ? "s" : ""}</Badge>}
          </div>
          <div ref={editorRef} className="min-h-0 flex-1 bg-bg">
            {ws.loading ? <div className="grid h-full place-items-center"><div className="flex items-center gap-2 text-sm text-muted"><Spinner />Reading folder…</div></div>
              : active && current !== undefined ? <Suspense fallback={<div className="grid h-full place-items-center"><Spinner /></div>}>{snap && snap.files[active] !== undefined ? <LazyDiff path={active} original={snap.files[active]!} modified={current} onChange={(v) => ws.set(active, v)} /> : <LazyEditor path={active} value={current} readOnly={ws.readonly.has(active)} onChange={(v) => ws.set(active, v)} onMarkers={(m) => setMarkers((all) => [...all.filter((x) => x.path !== active), ...m])} />}</Suspense>
              : isEmpty ? <EmptyState icon={<FolderGit2 className="size-5" />} title="This workspace is empty" body="Create a file, upload some, rip a GitHub repo, or have AI Studio build an app — the files land here." action={<div className="flex gap-2"><Button variant="primary" onClick={() => nav("/studio")}>Build with AI</Button><Button variant="secondary" onClick={() => nav("/repo-rip")}>Rip a repo</Button></div>} />
              : <EmptyState icon={<CodeXml className="size-5" />} title="Pick a file" body="Choose one from the tree. Edits save automatically." />}
          </div>
        </section>

        <aside className={cn("min-h-0 flex-col border-l border-line", mobile === "panel" ? "flex" : "hidden lg:flex")}>
          <div className="flex items-center overflow-x-auto border-b border-line [scrollbar-width:none]" role="tablist" aria-label="Panels">{panels.map((p) => <button key={p.id} role="tab" aria-selected={panel === p.id} onClick={() => setPanel(p.id)} className={cn("flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[13px] font-medium transition", panel === p.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}>{p.icon}{p.label}{p.badge ? <Badge tone={p.id === "problems" ? "bad" : "info"}>{p.badge}</Badge> : null}</button>)}</div>
          <div className="min-h-0 flex-1 overflow-auto">
            {panel === "preview" && <PreviewPanel ws={ws} devUrl={devUrl} />}
            {panel === "terminal" && <div className="flex h-full flex-col">{ws.rootId && <TestsBar ws={ws} runner={runner} />}<div className="min-h-0 flex-1"><TerminalPanel runner={runner} disabled={ws.rootId ? undefined : "Switch the workspace to a folder on your Mac to run installs, builds and tests. Commands only run in folders you approved."} /></div></div>}
            {panel === "git" && <GitPanel rootId={ws.rootId} />}
            {panel === "problems" && <ProblemsPanel markers={markers.filter((m) => open.includes(m.path))} onJump={(m) => openFile(m.path)} />}
            {panel === "history" && <HistoryPanel ws={ws} compare={compare} onCompare={(id) => { setCompare(id); if (id && !active) toast.info("Open a file to see its diff"); }} />}
          </div>
        </aside>
      </div>
    </div>
  );
}
