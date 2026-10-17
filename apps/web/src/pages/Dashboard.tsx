import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowUpRight, Bot, Boxes, Cpu, GitFork, Microscope, Plug, Puzzle, Rocket, Sparkles } from "lucide-react";
import type { Investigation } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { ago, fmtNum } from "@/lib/utils";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, Progress, Stat, StatusDot } from "@/components/ui/primitives";
import { Omnibox } from "@/components/domain/Omnibox";
import { CoverageRing, StatusBadge, TechChips } from "@/components/domain/bits";

export default function Dashboard() {
  const { project, jobs, models, providers, bridgeState, bridgeInfo, settings } = useApp();
  const nav = useNavigate();
  const invs = ((project?.investigations ?? []) as unknown as Investigation[]).slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const totals = useMemo(() => ({ pages: invs.reduce((n, i) => n + i.pages.length, 0), features: invs.reduce((n, i) => n + i.features.length, 0), evidence: invs.reduce((n, i) => n + i.evidence.length, 0) }), [invs]);
  const running = Object.values(jobs).filter((j) => j.status === "running");
  const localServices = (bridgeInfo?.runtimes.services ?? []).filter((s: any) => s.status === "reachable");
  const nProv = new Set(models.map((m) => m.provider)).size;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <section className="relative overflow-hidden rounded-3xl border border-line bg-surface p-5 sm:p-8">
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(60%_80%_at_50%_0%,black,transparent)]" />
        <div className="relative mx-auto max-w-3xl space-y-5 text-center">
          <div className="space-y-2"><h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-4xl">Understand any app. <span className="text-gradient">Rebuild it better.</span></h1><p className="mx-auto max-w-xl text-pretty text-sm text-muted sm:text-[15px]">Paste a website or GitHub repo, or drop files. You get an evidence-linked analysis — then extract features, re-create it in any stack, or ship it.</p></div>
          <Omnibox />
          <div className="flex flex-wrap justify-center gap-2 text-xs">
            {[{ t: "Rip a GitHub repo", to: "/repo-rip", i: GitFork }, { t: "Build from a prompt", to: "/studio", i: Sparkles }, { t: "Browse features", to: "/features", i: Puzzle }].map((q) => <Link key={q.to} to={q.to} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-bg px-3 py-1.5 text-muted transition hover:border-line-strong hover:text-fg"><q.i className="size-3.5" />{q.t}</Link>)}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card className="p-4"><Stat label="Investigations" value={invs.length} icon={<Microscope className="size-3" />} sub={`${invs.filter((i) => i.status === "done").length} complete`} /></Card>
        <Card className="p-4"><Stat label="Pages analysed" value={fmtNum(totals.pages)} icon={<Boxes className="size-3" />} /></Card>
        <Card className="p-4"><Stat label="Features found" value={fmtNum(totals.features)} icon={<Puzzle className="size-3" />} /></Card>
        <Card className="p-4"><Stat label="Evidence records" value={fmtNum(totals.evidence)} sub="each with source & hash" /></Card>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Recent investigations</CardTitle><Button size="xs" variant="ghost" onClick={() => nav("/investigations")}>View all</Button></CardHeader>
          {invs.length === 0 ? <EmptyState icon={<Microscope className="size-5" />} title="No investigations yet" body="Paste a URL above to run your first one. It takes about 10–40 seconds for a typical site." />
            : <ul className="divide-y divide-line">{invs.slice(0, 6).map((i) => (
              <li key={i.id}><Link to={`/investigations/${i.id}`} className="group flex items-center gap-3 px-4 py-3 transition hover:bg-elevated">
                <CoverageRing value={i.coverage.score} />
                <div className="min-w-0 flex-1 space-y-1.5"><div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{i.name}</span><StatusBadge s={i.status} /></div><TechChips inv={i} max={4} /></div>
                <div className="hidden text-right text-xs text-muted sm:block"><div>{i.pages.length ? `${i.pages.length} pages` : `${i.files.length} files`} · {i.features.length} features</div><div className="text-faint">{ago(i.startedAt)}</div></div>
                <ArrowUpRight className="size-4 text-faint transition group-hover:text-fg" />
              </Link></li>))}</ul>}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Status</CardTitle></CardHeader>
            <CardBody className="space-y-3 text-sm">
              <Row icon={<Bot className="size-4" />} label="AI providers" value={nProv ? `${nProv} · ${models.length} models` : "None connected"} tone={nProv ? "ok" : "idle"} to="/studio" />
              <Row icon={<Cpu className="size-4" />} label="Local models" value={bridgeState === "connected" ? (localServices.length ? localServices.map((s: any) => s.presetId).join(", ") : "None running") : "Needs desktop"} tone={localServices.length ? "ok" : "idle"} to="/models" />
              <Row icon={<Plug className="size-4" />} label="Desktop companion" value={bridgeState === "connected" ? `v${bridgeInfo?.version ?? "?"}` : "Not connected"} tone={bridgeState === "connected" ? "ok" : "idle"} to="/integrations" />
              <Row icon={<Rocket className="size-4" />} label="Deployments" value={`${project?.deployments.length ?? 0} recorded`} tone="idle" to="/deployments" />
              <div className="flex items-center justify-between border-t border-line pt-3 text-xs text-muted"><span>Privacy</span><Badge tone={settings.localOnly ? "ok" : "neutral"}>{settings.localOnly ? "Local-only" : "Cloud allowed"}</Badge></div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader><CardTitle>Active jobs</CardTitle></CardHeader>
            <CardBody className="space-y-3">
              {running.length === 0 ? <p className="text-[13px] text-muted">Nothing running.</p> : running.map((j) => <Link key={j.id} to={`/analyze?job=${j.id}`} className="block space-y-1.5 rounded-lg p-1 hover:bg-elevated"><div className="flex items-center justify-between text-[13px] font-medium"><span className="truncate">{j.label}</span><span className="text-xs tabular-nums text-muted">{Math.round(j.progress * 100)}%</span></div><Progress value={j.progress} /></Link>)}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ icon, label, value, tone, to }: { icon: React.ReactNode; label: string; value: string; tone: "ok" | "idle"; to: string }) {
  return <Link to={to} className="group flex items-center gap-3 rounded-lg px-1 py-0.5 text-[13px] transition hover:text-accent"><span className="text-muted group-hover:text-accent">{icon}</span><span className="text-muted">{label}</span><span className="ml-auto flex min-w-0 items-center gap-2 truncate font-medium text-fg"><StatusDot tone={tone} /><span className="truncate">{value}</span></span></Link>;
}
