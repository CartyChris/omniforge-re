import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { ArrowRight, FileArchive, FolderUp, Globe, GitFork, Upload } from "lucide-react";
import { analyzeFiles, analyzeWebsites, collectFiles, detectInput } from "@/lib/analyze";
import { ls } from "@/lib/storage";
import { Button, Badge, Kbd } from "@/components/ui/primitives";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";

/** One-time acknowledgement of the authorised-use boundaries (explicit scope, no bypassing access controls). */
export function useAuthorization() {
  const [ask, setAsk] = useState<null | (() => void)>(null);
  const dialog = (
    <Dialog open={!!ask} onOpenChange={(o) => { if (!o) setAsk(null); }}>
      <DialogContent title="Analyse only what you're allowed to" description="OmniForge RE works strictly within authorised scope.">
        <div className="space-y-4 text-sm leading-relaxed text-muted">
          <ul className="list-disc space-y-1.5 pl-5"><li>Only analyse sites, apps and code you own or have permission to examine.</li><li>robots.txt, rate limits and crawl scope are respected. Logins, paywalls, CAPTCHAs and other access controls are never bypassed.</li><li>Only publicly reachable content is fetched; secrets found in analysed material are redacted, never stored or shown.</li><li>Rebuilt applications are independent implementations; recovered source may carry the owner's licence.</li></ul>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setAsk(null)}>Cancel</Button><Button variant="primary" autoFocus onClick={() => { ls.setRaw("omniforge.ack", "1"); const f = ask; setAsk(null); f?.(); }}>I understand — continue</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
  const guard = (fn: () => void) => { if (ls.raw("omniforge.ack") === "1") fn(); else setAsk(() => fn); };
  return { guard, dialog };
}

export function Omnibox({ autoFocus, compact, onStarted }: { autoFocus?: boolean; compact?: boolean; onStarted?: (jobId: string) => void }) {
  const [text, setText] = useState("");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const { guard, dialog } = useAuthorization();
  const d = useMemo(() => detectInput(text), [text]);
  useEffect(() => { dirRef.current?.setAttribute("webkitdirectory", ""); }, []);

  const submit = () => {
    if (d.kind === "empty") return;
    if (d.kind === "invalid") return void toast.error(`Couldn't read “${d.invalid[0]}” as a URL or repository.`);
    if (d.repos.length) { nav(`/repo-rip?repos=${encodeURIComponent(d.repos.join("\n"))}`); return; }
    guard(async () => { const id = await analyzeWebsites(d.websites); onStarted?.(id); nav(`/analyze?job=${id}`); });
  };
  const files = (picked: Awaited<ReturnType<typeof collectFiles>>) => { if (!picked.length) return; guard(async () => { const id = await analyzeFiles(picked); onStarted?.(id); nav(`/analyze?job=${id}`); }); };

  return (
    <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={async (e) => { e.preventDefault(); setDrag(false); files(await collectFiles(e.dataTransfer.items.length ? e.dataTransfer.items : e.dataTransfer.files)); }}
      className={cn("rounded-2xl border bg-surface transition", drag ? "border-accent glow" : "border-line focus-within:border-accent/60 focus-within:shadow-[0_0_0_4px_color-mix(in_oklab,var(--accent)_14%,transparent)]", compact ? "p-2" : "p-2.5")}>
      <div className="flex items-center gap-2">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">{d.kind === "repo" ? <GitFork className="size-5" /> : <Globe className="size-5" />}</div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} autoFocus={autoFocus} aria-label="Website URL, GitHub repository, or files to analyse" spellCheck={false}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder="Paste a website or GitHub repo URL…"
          className="h-10 min-h-10 flex-1 resize-none bg-transparent py-2.5 text-[15px] leading-5 outline-none placeholder:text-faint" style={{ height: text.includes("\n") ? Math.min(160, 24 * (text.split("\n").length + 1)) : undefined }} />
        <Button variant="primary" size="lg" className="shrink-0" onClick={submit} disabled={d.kind === "empty"} icon={<ArrowRight className="size-4" />}><span className="hidden sm:inline">{d.kind === "repo" ? "Rip" : "Analyze"}</span></Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 px-1 pb-0.5">
        {d.kind !== "empty" && <>{d.websites.length > 0 && <Badge tone="info">{d.websites.length} website{d.websites.length > 1 ? "s" : ""}</Badge>}{d.repos.length > 0 && <Badge tone="teal">{d.repos.length} repo{d.repos.length > 1 ? "s" : ""}</Badge>}{d.invalid.length > 0 && <Badge tone="warn">{d.invalid.length} unrecognised</Badge>}{d.kind === "mixed" && <span className="text-[11px] text-warn">Repos open in Repo Rip first; run websites separately.</span>}</>}
        {d.kind === "empty" && <span className="text-[11px] text-faint">Multiple URLs allowed (one per line). Press <Kbd>Enter</Kbd> to start.</span>}
        <div className="ml-auto flex items-center gap-1">
          <input ref={fileRef} type="file" multiple hidden onChange={async (e) => { files(await collectFiles(e.target.files ?? [])); e.target.value = ""; }} />
          <input ref={dirRef} type="file" hidden multiple onChange={async (e) => { files(await collectFiles(e.target.files ?? [])); e.target.value = ""; }} />
          <Button size="xs" variant="ghost" icon={<FileArchive className="size-3.5" />} onClick={() => fileRef.current?.click()}>Files / ZIP</Button>
          <Button size="xs" variant="ghost" icon={<FolderUp className="size-3.5" />} onClick={() => dirRef.current?.click()}>Folder</Button>
        </div>
      </div>
      {drag && <div className="pointer-events-none mt-2 flex items-center justify-center gap-2 rounded-xl border border-dashed border-accent/60 bg-accent-soft py-4 text-sm text-accent"><Upload className="size-4" />Drop to analyse</div>}
      {dialog}
    </div>
  );
}
