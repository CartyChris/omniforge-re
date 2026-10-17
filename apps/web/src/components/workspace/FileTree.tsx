import { useMemo, useRef, useState } from "react";
import { ChevronRight, FilePlus2, FileText, Folder, FolderOpen, Pencil, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button, Input } from "@/components/ui/primitives";
import type { WorkspaceApi } from "@/lib/workspace";

interface Node { name: string; path: string; dir: boolean; children: Node[] }
function build(paths: string[]): Node[] {
  const root: Node = { name: "", path: "", dir: true, children: [] };
  for (const p of paths) { let cur = root; const parts = p.split("/"); parts.forEach((part, i) => { const path = parts.slice(0, i + 1).join("/"); let n = cur.children.find((c) => c.name === part && c.dir === (i < parts.length - 1)); if (!n) { n = { name: part, path, dir: i < parts.length - 1, children: [] }; cur.children.push(n); } cur = n; }); }
  const sort = (n: Node) => { n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1)); n.children.forEach(sort); };
  sort(root); return root.children;
}

export function FileTree({ ws, active, onOpen, onClosed }: { ws: WorkspaceApi; active?: string; onOpen: (p: string) => void; onClosed: (p: string) => void }) {
  const [q, setQ] = useState(""); const [open, setOpen] = useState<Set<string>>(new Set(["src", "app"])); const upload = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<{ mode: "new" | "rename"; path: string } | null>(null); const [val, setVal] = useState("");
  const paths = useMemo(() => (q ? ws.paths.filter((p) => p.toLowerCase().includes(q.toLowerCase())) : ws.paths), [ws.paths, q]);
  const tree = useMemo(() => build(paths), [paths]);
  const submit = () => { try { if (editing?.mode === "new") { ws.add(val); onOpen(val.replace(/^\/+/, "")); } else if (editing) { ws.rename(editing.path, val); onClosed(editing.path); onOpen(val); } setEditing(null); } catch (e) { toast.error((e as Error).message); } };
  const row = (n: Node, depth: number): React.ReactNode => {
    const isOpen = q ? true : open.has(n.path);
    return (
      <li key={n.path}>
        <div className={cn("group flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-[13px] transition hover:bg-overlay", !n.dir && active === n.path && "bg-accent-soft text-accent")} style={{ paddingLeft: 6 + depth * 12 }} onClick={() => (n.dir ? setOpen((s) => { const x = new Set(s); x.has(n.path) ? x.delete(n.path) : x.add(n.path); return x; }) : onOpen(n.path))} title={n.path}>
          {n.dir ? <><ChevronRight className={cn("size-3.5 shrink-0 text-faint transition", isOpen && "rotate-90")} />{isOpen ? <FolderOpen className="size-4 shrink-0 text-warn/80" /> : <Folder className="size-4 shrink-0 text-warn/80" />}</> : <><span className="w-3.5" /><FileText className="size-4 shrink-0 text-muted" /></>}
          <span className="min-w-0 flex-1 truncate">{n.name}</span>
          {!n.dir && ws.readonly.has(n.path) && <span className="text-[10px] text-faint">ro</span>}
          {!n.dir && <span className="hidden gap-0.5 group-hover:flex"><button aria-label={`Rename ${n.name}`} className="rounded p-0.5 text-faint hover:text-fg" onClick={(e) => { e.stopPropagation(); setEditing({ mode: "rename", path: n.path }); setVal(n.path); }}><Pencil className="size-3.5" /></button><button aria-label={`Delete ${n.name}`} className="rounded p-0.5 text-faint hover:text-bad" onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete ${n.path}?${ws.kind === "local" ? " This deletes the file on disk." : ""}`)) { ws.remove(n.path); onClosed(n.path); } }}><Trash2 className="size-3.5" /></button></span>}
        </div>
        {n.dir && isOpen && <ul>{n.children.map((c) => row(c, depth + 1))}</ul>}
      </li>
    );
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-line p-2"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-faint" /><Input className="h-7 pl-7 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter files" aria-label="Filter files" /></div>
        <Button size="icon-sm" variant="ghost" aria-label="New file" title="New file" onClick={() => { setEditing({ mode: "new", path: "" }); setVal(""); }}><FilePlus2 className="size-4" /></Button>
        {ws.kind === "browser" && <><input ref={upload} type="file" multiple hidden onChange={async (e) => { for (const f of Array.from(e.target.files ?? [])) { if (f.size > 2_000_000) { toast.error(`${f.name} is over 2 MB`); continue; } try { const t = await f.text(); if (t.includes("\0")) { toast.error(`${f.name} looks binary`); continue; } ws.set((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, t); } catch { toast.error(`Couldn't read ${f.name}`); } } e.target.value = ""; }} /><Button size="icon-sm" variant="ghost" aria-label="Upload files" title="Upload text files" onClick={() => upload.current?.click()}><Upload className="size-4" /></Button></>}</div>
      {editing && <form className="flex gap-1 border-b border-line p-2" onSubmit={(e) => { e.preventDefault(); submit(); }}><Input autoFocus className="h-7 text-xs" value={val} onChange={(e) => setVal(e.target.value)} placeholder={editing.mode === "new" ? "src/components/Button.tsx" : "new/path.ts"} aria-label="File path" /><Button type="submit" size="xs" variant="primary">OK</Button><Button type="button" size="xs" variant="ghost" onClick={() => setEditing(null)}>×</Button></form>}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{ws.loading ? <p className="p-3 text-xs text-muted">Reading folder…</p> : tree.length === 0 ? <p className="p-3 text-xs text-muted">{q ? "No files match." : "Empty. Create a file, upload some, or build one in AI Studio."}</p> : <ul>{tree.map((n) => row(n, 0))}</ul>}{ws.skipped.length > 0 && <p className="px-2 py-2 text-[11px] text-faint">{ws.skipped.length} large/binary file(s) not loaded.</p>}</div>
    </div>
  );
}
