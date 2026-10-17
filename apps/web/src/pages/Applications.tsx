import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Archive, Boxes, Check, Download, FolderOpen, History, Plus, RotateCcw, ShieldCheck, Trash2, Upload } from "lucide-react";
import { createSnapshot, diffSnapshots, exportProject, restoreSnapshot, type Project } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { db } from "@/lib/storage";
import { ago, download, fmtNum } from "@/lib/utils";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, Field, Input, SectionTitle, Textarea } from "@/components/ui/primitives";
import { Dialog, DialogContent, ToggleRow } from "@/components/ui/overlay";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";

export default function Applications() {
  const { project, projects, newProject, openProject, deleteProject, mutate, importProjectFile } = useApp();
  const nav = useNavigate(); const fileRef = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false); const [name, setName] = useState("");
  const [label, setLabel] = useState(""); const [compare, setCompare] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const exportById = async (id: string) => { const p = id === project?.id ? project : await db.get<Project>(`project:${id}`); if (!p) return toast.error("Project not found"); download(`${slug(p.name)}.omniforge.zip`, exportProject(p), "application/zip"); };
  const onImport = async (f?: File) => { if (!f) return; try { await importProjectFile(new Uint8Array(await f.arrayBuffer())); toast.success("Project imported"); } catch (e) { toast.error((e as Error).message); } };
  const snap = project?.snapshots.find((s) => s.id === compare);
  const diff = snap && project ? diffSnapshots(snap.files, project.workspace.files) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <SectionTitle title="Applications" sub="Projects hold your investigations, generated code, checkpoints and deployments. Export one and import it into the web or macOS app — same format."
        right={<><input ref={fileRef} type="file" accept=".zip,.json,application/zip,application/json" hidden onChange={(e) => { void onImport(e.target.files?.[0]); e.target.value = ""; }} /><Button variant="secondary" icon={<Upload className="size-4" />} onClick={() => fileRef.current?.click()}>Import</Button><Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New project</Button></>} />

      <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-3" aria-label="Projects">
        {projects.map((p) => (
          <Card key={p.id} className={p.id === project?.id ? "border-accent/50" : ""}>
            <CardBody className="space-y-3">
              <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="truncate text-sm font-semibold">{p.name}</h3><p className="text-xs text-faint">updated {ago(p.updatedAt)}</p></div>{p.id === project?.id ? <Badge tone="accent" dot>Active</Badge> : null}</div>
              <div className="grid grid-cols-4 gap-2 text-center text-xs"><Mini n={p.stats.investigations} l="cases" /><Mini n={p.stats.files} l="files" /><Mini n={p.stats.features} l="features" /><Mini n={p.stats.deployments} l="deploys" /></div>
              {p.localOnly && <Badge tone="ok"><ShieldCheck className="mr-1 inline size-3" />local-only</Badge>}
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant={p.id === project?.id ? "secondary" : "primary"} icon={<FolderOpen className="size-3.5" />} onClick={async () => { await openProject(p.id); nav("/workspace"); }}>Open</Button>
                <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => exportById(p.id)}>Export</Button>
                <Button size="sm" variant="ghost" className="ml-auto text-bad hover:text-bad" aria-label={`Delete ${p.name}`} icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDel(p.id)} />
              </div>
            </CardBody>
          </Card>
        ))}
      </section>

      {project && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Active project</CardTitle></CardHeader>
            <CardBody className="space-y-4">
              <Field label="Name"><Input value={project.name} onChange={(e) => mutate((p) => ({ ...p, name: e.target.value }))} /></Field>
              <Field label="Description"><Textarea rows={2} value={project.description} onChange={(e) => mutate((p) => ({ ...p, description: e.target.value }))} placeholder="What is this project for?" /></Field>
              <ToggleRow title="Local-only project" desc="Never send this project's content to cloud AI providers; only local models are used." checked={project.localOnly} onChange={(v) => mutate((p) => ({ ...p, localOnly: v }))} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Archive className="size-4" />Checkpoints</CardTitle><span className="text-xs text-muted">{project.snapshots.length}</span></CardHeader>
            <CardBody className="space-y-3">
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); mutate((p) => createSnapshot(p, label.trim() || `Checkpoint ${new Date().toLocaleTimeString()}`).project); setLabel(""); toast.success("Checkpoint saved"); }}><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" aria-label="Checkpoint label" /><Button type="submit" variant="secondary" icon={<Check className="size-4" />} disabled={Object.keys(project.workspace.files).length === 0}>Save</Button></form>
              {project.snapshots.length === 0 ? <p className="text-[13px] text-muted">{Object.keys(project.workspace.files).length ? "No checkpoints yet. Save one before big changes — restoring is undoable too." : "Checkpoints snapshot the workspace files, so they appear once the project has code."}</p>
                : <ul className="divide-y divide-line rounded-lg border border-line">{project.snapshots.map((s) => <li key={s.id} className="flex items-center gap-2 px-3 py-2 text-[13px]"><div className="min-w-0 flex-1"><div className="truncate font-medium">{s.label}</div><div className="text-xs text-faint">{ago(s.at)} · {Object.keys(s.files).length} files</div></div><Button size="xs" variant="ghost" onClick={() => setCompare(s.id)} icon={<History className="size-3.5" />}>Compare</Button><Button size="xs" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => { mutate((p) => restoreSnapshot(p, s.id)); toast.success("Restored — an automatic backup of the previous state was saved"); }}>Restore</Button></li>)}</ul>}
            </CardBody>
          </Card>
          {(project.deployments.length > 0 || project.builds.length > 0) && <Card className="lg:col-span-2"><CardHeader><CardTitle>History</CardTitle></CardHeader><ul className="divide-y divide-line">{[...project.deployments.map((d) => ({ at: d.at, t: `Deploy · ${d.provider}`, ok: !/fail|error/i.test(d.status), d: d.url ?? d.status })), ...project.builds.map((b) => ({ at: b.at, t: `${b.kind}`, ok: b.ok, d: b.log.split("\n")[0] ?? "" }))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15).map((h, i) => <li key={i} className="flex items-center gap-3 px-4 py-2 text-[13px]"><Badge tone={h.ok ? "ok" : "bad"}>{h.ok ? "ok" : "failed"}</Badge><span className="font-medium">{h.t}</span><span className="min-w-0 flex-1 truncate text-muted">{h.d}</span><span className="text-xs text-faint">{ago(h.at)}</span></li>)}</ul></Card>}
        </div>
      )}
      {projects.length === 0 && <Card><EmptyState icon={<Boxes className="size-5" />} title="No projects" body="Create one, or import a project file exported from the web or macOS app." /></Card>}

      <Dialog open={creating} onOpenChange={setCreating}><DialogContent title="New project" description="A project keeps related investigations, code and deployments together."><form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; await newProject(name.trim()); setCreating(false); setName(""); }}><Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rebuild of acme.com" /></Field><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={!name.trim()}>Create</Button></div></form></DialogContent></Dialog>
      <Dialog open={!!confirmDel} onOpenChange={(o) => !o && setConfirmDel(null)}><DialogContent title="Delete this project?" description="Its investigations, files and checkpoints are removed from this browser. Exported copies are not affected."><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setConfirmDel(null)}>Keep</Button><Button variant="danger" onClick={async () => { if (confirmDel) await deleteProject(confirmDel); setConfirmDel(null); toast.success("Deleted"); }}>Delete</Button></div></DialogContent></Dialog>
      <Dialog open={!!snap} onOpenChange={(o) => !o && setCompare(null)}>{snap && diff && <DialogContent title={`Changes since “${snap.label}”`} description={`${diff.added.length} added · ${diff.changed.length} changed · ${diff.removed.length} removed (vs the current workspace)`}><div className="space-y-4 text-[13px]">{([["Added", diff.added, "ok"], ["Changed", diff.changed, "warn"], ["Removed", diff.removed, "bad"]] as const).map(([t, list, tone]) => list.length > 0 && <div key={t}><Badge tone={tone}>{t} {fmtNum(list.length)}</Badge><ul className="mt-2 max-h-40 overflow-auto font-mono text-xs text-muted">{list.slice(0, 200).map((f) => <li key={f}>{f}</li>)}</ul></div>)}{!diff.added.length && !diff.changed.length && !diff.removed.length && <p className="text-muted">The workspace is identical to this checkpoint.</p>}</div></DialogContent>}</Dialog>
    </div>
  );
}
const Mini = ({ n, l }: { n: number; l: string }) => <div><div className="text-sm font-semibold tabular-nums">{fmtNum(n)}</div><div className="text-faint">{l}</div></div>;
