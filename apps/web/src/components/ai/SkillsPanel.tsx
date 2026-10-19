import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BookOpen, FolderOpen, RefreshCw, TriangleAlert, Upload } from "lucide-react";
import type { SkillProblem } from "@omniforge/core";
import { allSkills, importSkillFiles, removeImportedSkill, setSkillEnabled, type SkillEntry } from "@/lib/skills";
import { useApp } from "@/lib/store";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState } from "@/components/ui/primitives";
import { Dialog, DialogContent, Switch } from "@/components/ui/overlay";

/** Agent Skills used by OmniForge's own agents (Build plans). Agent CLIs such as Claude Code load their own skills themselves. */
export function SkillsPanel() {
  const connected = useApp((s) => s.bridgeState === "connected");
  const [skills, setSkills] = useState<SkillEntry[]>([]); const [disabled, setDisabled] = useState<string[]>([]); const [problems, setProblems] = useState<SkillProblem[]>([]); const [importProblems, setImportProblems] = useState<SkillProblem[]>([]);
  const [view, setView] = useState<SkillEntry | null>(null); const [busy, setBusy] = useState(false);
  const zip = useRef<HTMLInputElement>(null); const dir = useRef<HTMLInputElement>(null);
  const refresh = async () => { setBusy(true); try { const r = await allSkills(); setSkills(r.skills); setDisabled(r.disabled); setProblems(r.problems); } finally { setBusy(false); } };
  useEffect(() => { void refresh(); }, [connected]);
  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return; const r = await importSkillFiles([...list]);
    if (r.added.length) toast.success(`Imported ${r.added.join(", ")}`); if (r.problems.length) toast.warning(r.problems.map((p) => `${p.path}: ${p.problem}`).join("\n"));
    setImportProblems(r.problems); await refresh();
  };
  return (
    <div className="space-y-5">
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><BookOpen className="size-4" />Agent Skills</CardTitle>
        <div className="flex items-center gap-2"><Button size="xs" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void refresh()}>Refresh</Button></div></CardHeader>
        <CardBody className="space-y-3 text-[13px]">
          <p className="text-muted">Skills are folders with a SKILL.md — the same format Claude Code uses. OmniForge's Build agents see each enabled skill's name and description and load the full instructions only when relevant. Skills cannot override the safety rules, grant no permissions, and their scripts are never run. {connected ? "Skills already on this Mac (~/.claude/skills, Claude Code plugins, ~/.agents/skills, ~/.codex/skills, ~/.config/omniforge/skills) are included automatically." : "In the desktop app, skills already on your Mac are included automatically."}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={<Upload className="size-4" />} onClick={() => zip.current?.click()}>Import .zip or SKILL.md</Button>
            <Button size="sm" variant="secondary" icon={<FolderOpen className="size-4" />} onClick={() => dir.current?.click()}>Import a skill folder</Button>
            <input ref={zip} type="file" accept=".zip,.md" multiple hidden aria-label="Skill archive or SKILL.md" onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
            <input ref={dir} type="file" hidden aria-label="Skill folder" {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
          </div>
          {[...importProblems, ...problems].length > 0 && <ul className="space-y-1 text-xs text-warn" data-testid="skill-problems">{[...importProblems, ...problems].slice(0, 12).map((p, i) => <li key={i} className="flex gap-1.5"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" /><span className="break-all">{p.path}: {p.problem}</span></li>)}</ul>}
        </CardBody></Card>
      {skills.length === 0 ? <Card><EmptyState title="No skills" body="Import a skill to get started." /></Card> :
        <Card><ul className="divide-y divide-line" data-testid="skills-list">{skills.map((s) => (
          <li key={s.name} className="flex items-start gap-3 px-4 py-3 text-[13px]">
            <div className="min-w-0 flex-1"><button className="font-medium hover:underline" onClick={() => setView(s)}>{s.name}</button> <Badge>{s.origin}</Badge>{s.flags.length > 0 && <Badge tone="warn" title={s.flags.join(", ")}>contains instruction-like text</Badge>}
              <p className="mt-0.5 text-muted">{s.description}</p></div>
            {s.origin === "Imported" && <Button size="xs" variant="ghost" onClick={() => void removeImportedSkill(s.name).then(refresh)}>Remove</Button>}
            <Switch aria-label={`Enable skill ${s.name}`} checked={!disabled.includes(s.name)} onCheckedChange={(on: boolean) => void setSkillEnabled(s.name, on).then(refresh)} />
          </li>))}</ul></Card>}
      <Dialog open={!!view} onOpenChange={(o) => !o && setView(null)}>{view && <DialogContent side="right" title={view.name} description={view.source}>
        <div className="space-y-3 text-[13px]"><p className="text-muted">{view.description}</p>
          <pre tabIndex={0} aria-label="Skill instructions" className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-overlay p-3 font-mono text-xs">{view.body}</pre>
          {Object.keys(view.files).length > 0 && <div><p className="text-xs font-medium text-muted">Resource files</p><ul className="font-mono text-xs text-muted">{Object.keys(view.files).map((f) => <li key={f}>{f}</li>)}</ul></div>}
        </div></DialogContent>}</Dialog>
    </div>
  );
}
