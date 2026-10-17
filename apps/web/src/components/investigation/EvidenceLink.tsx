import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { FileSearch } from "lucide-react";
import type { Evidence, Investigation } from "@omniforge/core";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Badge, CopyButton } from "@/components/ui/primitives";
import { ConfidenceBar, KindBadge, kindHelp } from "@/components/domain/bits";
import { cn } from "@/lib/utils";

interface Ctx { inv: Investigation; byId: Map<string, Evidence>; open(id: string): void }
const EvCtx = createContext<Ctx | null>(null);
export const useEvidence = () => { const c = useContext(EvCtx); if (!c) throw new Error("EvidenceProvider missing"); return c; };

/** Makes every evidence id in the investigation clickable → a side panel with source, method, hash, confidence and snippet. */
export function EvidenceProvider({ inv, children }: { inv: Investigation; children: ReactNode }) {
  const [openId, setOpen] = useState<string | null>(null);
  const byId = useMemo(() => new Map(inv.evidence.map((e) => [e.id, e])), [inv.evidence]);
  const ev = openId ? byId.get(openId) : undefined;
  const value = useMemo<Ctx>(() => ({ inv, byId, open: setOpen }), [inv, byId]);
  const related = ev?.related?.map((r) => ({ id: r, ev: byId.get(r) })) ?? [];
  return (
    <EvCtx.Provider value={value}>
      {children}
      <Dialog open={!!ev} onOpenChange={(o) => { if (!o) setOpen(null); }}>
        {ev && (
          <DialogContent side="right" title="Evidence" description={ev.id}>
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-2"><KindBadge kind={ev.kind} /><Badge>{ev.method}</Badge><ConfidenceBar value={ev.confidence} /></div>
              <p className="text-[13px] text-muted">{kindHelp[ev.kind]}</p>
              <p className="leading-relaxed">{ev.summary}</p>
              <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 text-[13px]">
                <dt className="text-faint">Source</dt><dd className="break-all font-mono text-xs">{ev.source || "—"} {ev.source && <CopyButton text={ev.source} label="" />}</dd>
                <dt className="text-faint">Captured</dt><dd>{new Date(ev.timestamp).toLocaleString()}</dd>
                {ev.hash && (<><dt className="text-faint">SHA-256</dt><dd className="break-all font-mono text-xs">{ev.hash}</dd></>)}
              </dl>
              {ev.snippet && <div><h4 className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Excerpt (secrets redacted)</h4><pre className="max-h-64 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{ev.snippet}</pre></div>}
              {related.length > 0 && <div><h4 className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Related</h4><ul className="space-y-1">{related.slice(0, 12).map((r) => <li key={r.id}>{r.ev ? <button className="text-left text-[13px] text-accent hover:underline" onClick={() => setOpen(r.id)}>{r.ev.summary.slice(0, 90)}</button> : <span className="font-mono text-xs text-faint">{r.id}</span>}</li>)}</ul></div>}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </EvCtx.Provider>
  );
}

/** Compact chips for a list of evidence ids. */
export function EvidenceChips({ ids, max = 3, className }: { ids: string[]; max?: number; className?: string }) {
  const { byId, open } = useEvidence();
  const shown = ids.filter((i) => byId.has(i));
  if (!shown.length) return <span className={cn("text-xs text-faint", className)}>no linked evidence</span>;
  return <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>{shown.slice(0, max).map((id) => { const e = byId.get(id)!; return <button key={id} onClick={(ev) => { ev.stopPropagation(); open(id); }} title={e.summary} className="inline-flex items-center gap-1 rounded-md border border-line bg-bg px-1.5 py-0.5 text-[11px] text-muted transition hover:border-accent/50 hover:text-accent"><FileSearch className="size-3" />{e.kind}</button>; })}{shown.length > max && <span className="text-[11px] text-faint">+{shown.length - max}</span>}</span>;
}
