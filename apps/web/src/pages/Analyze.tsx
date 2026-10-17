import { useState } from "react";
import { useSearchParams } from "react-router";
import { ChevronDown, SlidersHorizontal, ShieldCheck } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, CardBody, SectionTitle } from "@/components/ui/primitives";
import { Omnibox } from "@/components/domain/Omnibox";
import { CrawlSettings } from "@/components/domain/CrawlSettings";
import { JobView } from "@/components/domain/JobView";
import { LocalTargets } from "@/components/domain/LocalTargets";
import { cn } from "@/lib/utils";

export default function Analyze() {
  const jobs = useApp((s) => s.jobs);
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const all = Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt);
  const selected = (params.get("job") && jobs[params.get("job")!]) || all[0];
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <SectionTitle title="Analyze" sub="One box for websites, GitHub repos, ZIPs and folders. Every result links back to the evidence it came from." />
      <div className="space-y-3">
        <Omnibox autoFocus={!selected} />
        <div className="flex items-center justify-between gap-3">
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-muted transition hover:bg-overlay hover:text-fg"><SlidersHorizontal className="size-4" />Crawl settings<ChevronDown className={cn("size-4 transition", open && "rotate-180")} /></button>
          <span className="hidden items-center gap-1.5 text-xs text-faint sm:flex"><ShieldCheck className="size-3.5" />Respects robots.txt · rate-limited · never bypasses logins</span>
        </div>
        {open && <Card><CardBody><CrawlSettings hostedCaps /></CardBody></Card>}
      </div>

      {selected && (
        <section className="space-y-3" aria-label="Current job">
          {all.length > 1 && <div className="flex flex-wrap gap-1.5">{all.slice(0, 8).map((j) => <Button key={j.id} size="xs" variant={j.id === selected.id ? "soft" : "ghost"} onClick={() => setParams({ job: j.id })}>{j.label}</Button>)}</div>}
          <JobView job={selected} />
        </section>
      )}

      <LocalTargets />
    </div>
  );
}
