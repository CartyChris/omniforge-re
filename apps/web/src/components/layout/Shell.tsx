import { forwardRef, useEffect, useMemo, useState, type ComponentProps } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Command } from "cmdk";
import { toast } from "sonner";
import { Activity, Check, ChevronDown, Cpu, FolderPlus, Loader2, MoreHorizontal, Moon, PanelLeft, Plug, Plus, Search, ShieldCheck, Sun, X, Zap } from "lucide-react";
import { NAV } from "@/nav";
import { cn, ago } from "@/lib/utils";
import { useApp } from "@/lib/store";
import { useApprovals } from "@/lib/approvals";
import { detectInput, analyzeWebsites } from "@/lib/analyze";
import { Button, Kbd, Progress, StatusDot } from "@/components/ui/primitives";
import { Dialog, DialogContent, Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSep, DropdownTrigger, Popover, PopoverContent, PopoverTrigger, Tip, TooltipProvider } from "@/components/ui/overlay";
import { Logo } from "./Logo";
import { Onboarding } from "./Onboarding";

/* ----------------------------- project switcher ----------------------------- */
function ProjectSwitcher() {
  const { project, projects, openProject, newProject } = useApp();
  const nav = useNavigate();
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button className="flex h-9 max-w-[14rem] items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-sm font-medium transition hover:border-line-strong" aria-label="Switch project">
          <span className="grid size-5 shrink-0 place-items-center rounded bg-accent-soft text-[10px] font-bold text-accent">{(project?.name ?? "P").slice(0, 1).toUpperCase()}</span>
          <span className="truncate">{project?.name ?? "No project"}</span><ChevronDown className="size-3.5 shrink-0 text-muted" />
        </button>
      </DropdownTrigger>
      <DropdownContent align="start" className="w-64">
        <DropdownLabel>Projects</DropdownLabel>
        {projects.slice(0, 12).map((p) => <DropdownItem key={p.id} onSelect={() => openProject(p.id)}><span className="truncate">{p.name}</span>{p.id === project?.id && <Check className="ml-auto size-3.5 text-accent" />}</DropdownItem>)}
        <DropdownSep />
        <DropdownItem onSelect={async () => { const name = window.prompt("Project name", "New project"); if (name) { await newProject(name); toast.success(`Created “${name}”`); nav("/analyze"); } }}><Plus className="size-4" />New project…</DropdownItem>
        <DropdownItem onSelect={() => nav("/applications")}><FolderPlus className="size-4" />Manage projects</DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}

/* ----------------------------- jobs popover ----------------------------- */
function JobsIndicator() {
  const jobs = useApp((s) => s.jobs);
  const { cancelJob, dismissJob } = useApp.getState();
  const nav = useNavigate();
  const list = Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt);
  const running = list.filter((j) => j.status === "running");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={cn("relative grid h-9 min-w-9 place-items-center rounded-lg border border-line bg-surface px-2 text-muted transition hover:text-fg", running.length && "border-accent/40 text-accent")} aria-label={`Jobs (${running.length} running)`}>
          {running.length ? <span className="flex items-center gap-1.5 text-xs font-semibold"><Loader2 className="size-3.5 animate-spin" />{running.length}</span> : <Activity className="size-4" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="border-b border-line px-3 py-2.5 text-[13px] font-semibold">Jobs</div>
        {!list.length && <p className="px-3 py-6 text-center text-[13px] text-muted">Nothing running. Start one from Analyze.</p>}
        <div className="max-h-80 divide-y divide-line overflow-y-auto">
          {list.map((j) => (
            <div key={j.id} className="space-y-1.5 px-3 py-2.5">
              <div className="flex items-center gap-2"><StatusDot tone={j.status === "running" ? "info" : j.status === "done" ? "ok" : j.status === "cancelled" ? "idle" : "bad"} pulse={j.status === "running"} /><span className="min-w-0 flex-1 truncate text-[13px] font-medium">{j.label}</span>
                {j.status === "running" ? <Button size="xs" variant="ghost" onClick={() => cancelJob(j.id)}>Cancel</Button> : <button className="text-faint hover:text-fg" onClick={() => dismissJob(j.id)} aria-label="Dismiss"><X className="size-3.5" /></button>}</div>
              {j.status === "running" && <><Progress value={j.progress} /><p className="text-[11px] text-muted">{j.stage ?? "Working"} · {j.counts.pages} pages · {j.counts.assets} assets</p></>}
              {j.status === "error" && <p className="line-clamp-3 whitespace-pre-line text-[11px] text-bad">{j.error}</p>}
              {j.status === "done" && j.investigationId && <Button size="xs" variant="soft" onClick={() => nav(`/investigations/${j.investigationId}`)}>Open results</Button>}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ----------------------------- status chips ----------------------------- */
function StatusChips() {
  const { settings, patchSettings, bridgeState, models } = useApp();
  const nav = useNavigate();
  const connected = bridgeState === "connected";
  const nProviders = new Set(models.map((m) => m.provider)).size;
  return (
    <div className="hidden items-center gap-2 md:flex">
      <Tip label={settings.localOnly ? "Local-only mode: nothing is sent to cloud models or the hosted service" : "Cloud models allowed. Click to switch to local-only."} side="bottom">
        <button onClick={() => patchSettings({ localOnly: !settings.localOnly })} className={cn("flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition", settings.localOnly ? "border-ok/40 bg-ok/10 text-ok" : "border-line bg-surface text-muted hover:text-fg")}>
          <ShieldCheck className="size-3.5" />{settings.localOnly ? "Local-only" : "Cloud on"}
        </button>
      </Tip>
      <Tip label={connected ? "Desktop companion connected" : "Connect the desktop companion for local folders, CLIs, REA and local models"} side="bottom">
        <button onClick={() => nav("/integrations")} className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-muted transition hover:text-fg"><StatusDot tone={connected ? "ok" : "idle"} />{connected ? "Desktop" : "Web only"}</button>
      </Tip>
      <Tip label={nProviders ? `${models.length} models from ${nProviders} provider(s)` : "No AI providers connected yet"} side="bottom">
        <button onClick={() => nav("/studio")} className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-muted transition hover:text-fg"><Cpu className="size-3.5" />{nProviders ? `${models.length} models` : "Add AI"}</button>
      </Tip>
    </div>
  );
}

/* ----------------------------- command palette ----------------------------- */
export function CommandPalette({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const { project, projects, openProject, patchSettings, settings } = useApp();
  const detected = useMemo(() => detectInput(q), [q]);
  const go = (to: string) => { setOpen(false); setQ(""); nav(to); };
  useEffect(() => { if (!open) setQ(""); }, [open]);
  const invs = (project?.investigations ?? []) as any[];
  return (
    <Command.Dialog open={open} onOpenChange={setOpen} label="Command palette" className="fixed inset-0 z-[80] flex items-start justify-center bg-black/60 p-4 pt-[12vh] backdrop-blur-[2px]" shouldFilter>
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-line-strong bg-elevated shadow-[var(--shadow-pop)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4"><Search className="size-4 text-muted" /><Command.Input value={q} onValueChange={setQ} placeholder="Type a URL, a GitHub repo, or search commands…" className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint" /><Kbd>esc</Kbd></div>
        <Command.List className="max-h-[60vh] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-8 text-center text-sm text-muted">No matches.</Command.Empty>
          {(detected.websites.length > 0 || detected.repos.length > 0) && (
            <Command.Group heading="Do it now" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint">
              {detected.websites.length > 0 && <Item value={`analyze ${q}`} keywords={[q]} onSelect={() => { setOpen(false); analyzeWebsites(detected.websites, {}).then((id) => { void id; nav("/analyze"); }); }} icon={<Zap className="size-4 text-accent" />}>Analyze {detected.websites.length > 1 ? `${detected.websites.length} websites` : detected.websites[0]}</Item>}
              {detected.repos.length > 0 && <Item value={`rip ${q}`} keywords={[q]} onSelect={() => go(`/repo-rip?repos=${encodeURIComponent(detected.repos.join("\n"))}`)} icon={<Zap className="size-4 text-teal" />}>Repo Rip {detected.repos.join(", ")}</Item>}
            </Command.Group>
          )}
          <Command.Group heading="Go to" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint">
            {NAV.map((n) => <Item key={n.id} value={`go ${n.label} ${n.desc}`} onSelect={() => go(n.to)} icon={<n.icon className="size-4 text-muted" />} hint={<span className="flex gap-1"><Kbd>g</Kbd><Kbd>{n.chord}</Kbd></span>}>{n.label}<span className="ml-2 hidden text-xs text-faint sm:inline">{n.desc}</span></Item>)}
          </Command.Group>
          <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint">
            <Item value="toggle theme dark light" onSelect={() => { patchSettings({ theme: settings.theme === "dark" ? "light" : "dark" }); setOpen(false); }} icon={settings.theme === "dark" ? <Sun className="size-4 text-muted" /> : <Moon className="size-4 text-muted" />}>Switch to {settings.theme === "dark" ? "light" : "dark"} theme</Item>
            <Item value="toggle local only privacy" onSelect={() => { patchSettings({ localOnly: !settings.localOnly }); setOpen(false); toast(settings.localOnly ? "Cloud models allowed" : "Local-only mode on"); }} icon={<ShieldCheck className="size-4 text-muted" />}>{settings.localOnly ? "Allow cloud models" : "Go local-only (privacy mode)"}</Item>
            <Item value="pair desktop companion bridge connect" onSelect={() => go("/integrations")} icon={<Plug className="size-4 text-muted" />}>Pair the desktop companion</Item>
            <Item value="new project" onSelect={async () => { const name = window.prompt("Project name", "New project"); if (name) { await useApp.getState().newProject(name); setOpen(false); } }} icon={<Plus className="size-4 text-muted" />}>New project…</Item>
          </Command.Group>
          {invs.length > 0 && <Command.Group heading="Investigations" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint">{invs.slice(0, 8).map((i) => <Item key={i.id} value={`investigation ${i.name} ${i.targets?.[0]?.value}`} onSelect={() => go(`/investigations/${i.id}`)} icon={<Search className="size-4 text-muted" />} hint={<span className="text-xs text-faint">{ago(i.startedAt)}</span>}>{i.name}</Item>)}</Command.Group>}
          {projects.length > 1 && <Command.Group heading="Switch project" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint">{projects.map((p) => <Item key={p.id} value={`project ${p.name}`} onSelect={() => { openProject(p.id); setOpen(false); }} icon={<FolderPlus className="size-4 text-muted" />}>{p.name}</Item>)}</Command.Group>}
        </Command.List>
      </div>
    </Command.Dialog>
  );
}
function Item({ children, icon, hint, onSelect, value, keywords }: { children: React.ReactNode; icon?: React.ReactNode; hint?: React.ReactNode; onSelect: () => void; value: string; keywords?: string[] }) {
  return <Command.Item value={value} keywords={keywords} onSelect={onSelect} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm outline-none data-[selected=true]:bg-overlay">{icon}<span className="min-w-0 flex-1 truncate">{children}</span>{hint}</Command.Item>;
}

/* ----------------------------- approvals ----------------------------- */
function ApprovalDialog() {
  const q = useApprovals((s) => s.queue); const settle = useApprovals((s) => s.settle);
  const r = q[0];
  return (
    <Dialog open={!!r} onOpenChange={(o) => { if (!o && r) settle(r.id, false); }}>
      {r && <DialogContent title={r.title} description={r.detail}>
        <div className="space-y-4">
          {r.command && <pre className="max-h-48 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs leading-relaxed">{r.command}</pre>}
          {r.danger && <p className="rounded-lg border border-bad/30 bg-bad/10 p-3 text-[13px] text-bad">This looks potentially destructive. Read it carefully before allowing.</p>}
          <p className="text-xs text-muted">Nothing runs until you approve. You can review every approved action in Settings → Diagnostics.</p>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => settle(r.id, false)}>Deny</Button><Button variant="primary" onClick={() => settle(r.id, true)} autoFocus>Allow once</Button></div>
        </div>
      </DialogContent>}
    </Dialog>
  );
}

/* ----------------------------- shell ----------------------------- */
/** NavLink wrapper that takes a plain className: Radix `asChild` (tooltips) merges className as a string, which breaks NavLink's function form. */
const RailLink = forwardRef<HTMLAnchorElement, ComponentProps<typeof NavLink>>(({ className: _c, ...p }, ref) => (
  <NavLink ref={ref} {...p} className={({ isActive }) => cn("group flex h-10 items-center gap-3 rounded-lg px-[11px] text-[13px] font-medium transition", isActive ? "bg-accent-soft text-accent" : "text-muted hover:bg-overlay hover:text-fg")} />
));
RailLink.displayName = "RailLink";

export function Shell() {
  const { settings, patchSettings, ready } = useApp();
  const [palette, setPalette] = useState(false);
  const [more, setMore] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();

  // ⌘K and g-chords
  useEffect(() => {
    let g = false; let timer: ReturnType<typeof setTimeout>;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); return; }
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true], .monaco-editor") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (g) { g = false; clearTimeout(timer); const hit = NAV.find((n) => n.chord === e.key.toLowerCase()); if (hit) { e.preventDefault(); nav(hit.to); } return; }
      if (e.key === "g") { g = true; timer = setTimeout(() => (g = false), 900); }
      if (e.key === "/") { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  if (!ready) return <div className="grid h-full place-items-center"><Logo className="size-10 animate-pulse" /></div>;
  const expanded = settings.sidebarExpanded;
  const mobileItems = NAV.filter((n) => n.mobile);
  return (
    <TooltipProvider>
      <div className="flex h-dvh overflow-hidden bg-bg text-fg">
        {/* rail (desktop) */}
        <aside className={cn("hidden shrink-0 flex-col border-r border-line bg-surface/60 transition-[width] duration-200 lg:flex", expanded ? "w-56" : "w-[60px]")} aria-label="Primary">
          <div className="flex h-14 items-center gap-2.5 px-[14px]"><Logo className="size-8 shrink-0" />{expanded && <span className="text-[15px] font-semibold tracking-tight">OmniForge <span className="text-gradient">RE</span></span>}</div>
          <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
            {NAV.filter((n) => n.id !== "settings").map((n) => (
              <Tip key={n.id} label={<span>{n.label}<span className="ml-2 text-faint">g {n.chord}</span></span>} side="right">
                <RailLink to={n.to} end={n.to === "/"}>
                  <n.icon className="size-[18px] shrink-0" />{expanded && <span className="truncate">{n.label}</span>}
                </RailLink>
              </Tip>
            ))}
          </nav>
          <div className="space-y-0.5 border-t border-line p-2">
            {NAV.filter((n) => n.id === "settings").map((n) => (
              <Tip key={n.id} label={n.label} side="right"><RailLink to={n.to}><n.icon className="size-[18px] shrink-0" />{expanded && n.label}</RailLink></Tip>
            ))}
            <Tip label={settings.theme === "dark" ? "Light theme" : "Dark theme"} side="right"><button onClick={() => patchSettings({ theme: settings.theme === "dark" ? "light" : "dark" })} className="flex h-10 w-full items-center gap-3 rounded-lg px-[11px] text-[13px] font-medium text-muted transition hover:bg-overlay hover:text-fg" aria-label="Toggle theme">{settings.theme === "dark" ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}{expanded && "Theme"}</button></Tip>
            <Tip label={expanded ? "Collapse" : "Expand"} side="right"><button onClick={() => patchSettings({ sidebarExpanded: !expanded })} className="flex h-10 w-full items-center gap-3 rounded-lg px-[11px] text-[13px] font-medium text-muted transition hover:bg-overlay hover:text-fg" aria-label="Toggle sidebar"><PanelLeft className="size-[18px]" />{expanded && "Collapse"}</button></Tip>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* top bar */}
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface/60 px-3 backdrop-blur sm:gap-3 sm:px-4">
            <div className="flex items-center gap-2 lg:hidden"><Logo className="size-7" /></div>
            <ProjectSwitcher />
            <button onClick={() => setPalette(true)} className="mx-auto hidden h-9 w-full max-w-md items-center gap-2 rounded-lg border border-line bg-bg px-3 text-left text-sm text-faint transition hover:border-line-strong sm:flex" aria-label="Open command palette"><Search className="size-4" /><span className="flex-1 truncate">Analyze a URL or repo, or jump anywhere…</span><span className="flex gap-1"><Kbd>⌘</Kbd><Kbd>K</Kbd></span></button>
            <div className="ml-auto flex items-center gap-2 sm:ml-0">
              <button onClick={() => setPalette(true)} className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-surface text-muted sm:hidden" aria-label="Search"><Search className="size-4" /></button>
              <StatusChips /><JobsIndicator />
            </div>
          </header>

          <main id="main" className="min-h-0 flex-1 overflow-y-auto pb-20 lg:pb-0" key={loc.pathname.split("/")[1]}><Outlet /></main>

          {/* bottom nav (mobile) */}
          <nav className="safe-b fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-line bg-surface/95 backdrop-blur lg:hidden" aria-label="Primary">
            {mobileItems.slice(0, 4).map((n) => <NavLink key={n.id} to={n.to} end={n.to === "/"} className={({ isActive }) => cn("flex min-h-14 flex-col items-center justify-center gap-0.5 text-[10px] font-medium", isActive ? "text-accent" : "text-muted")}><n.icon className="size-5" />{n.short ?? n.label}</NavLink>)}
            <button onClick={() => setMore(true)} className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-muted" aria-label="More sections"><MoreHorizontal className="size-5" />More</button>
          </nav>
        </div>
      </div>

      <Dialog open={more} onOpenChange={setMore}>
        <DialogContent title="All sections" side="bottom">
          <div className="grid grid-cols-3 gap-2">
            {NAV.map((n) => <button key={n.id} onClick={() => { setMore(false); nav(n.to); }} className="flex min-h-[4.5rem] flex-col items-center justify-center gap-1.5 rounded-xl border border-line bg-bg p-2 text-center text-xs font-medium text-muted transition active:scale-95 hover:text-fg"><n.icon className="size-5" />{n.short ?? n.label}</button>)}
          </div>
        </DialogContent>
      </Dialog>

      <CommandPalette open={palette} setOpen={setPalette} />
      <ApprovalDialog />
      <Onboarding />
    </TooltipProvider>
  );
}
