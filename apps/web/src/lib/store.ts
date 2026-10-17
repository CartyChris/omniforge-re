import { create } from "zustand";
import { toast } from "sonner";
import { createProject, exportProject as coreExport, importProject as coreImport, projectStats, upsertInvestigation, type CrawlConfig, type Investigation, type LogEntry, type ModelInfo, type Project, type ProviderConfig, type TaskKind, DEFAULT_CRAWL } from "@omniforge/core";
import { db, ls } from "./storage";
import { Bridge, isTauri, probe, tauriBridge, type BridgeConn } from "./bridge";
import { debounce } from "./utils";
import { appLog } from "./log";

export interface ProjectIndexItem { id: string; name: string; updatedAt: string; stats: ReturnType<typeof projectStats>; localOnly: boolean }
export interface LivePage { id: string; url: string; status: number; title: string; depth: number; via: string }
export interface LiveJob {
  id: string; kind: "web" | "source" | "repo" | "rea" | "folder" | "package"; label: string; targets: string[]; status: "running" | "done" | "error" | "cancelled";
  progress: number; counts: { pages: number; assets: number; evidence: number }; log: LogEntry[]; pages: LivePage[]; startedAt: number; endedAt?: number; error?: string; investigationId?: string; abort?: AbortController; stage?: string;
}
export interface Settings {
  theme: "dark" | "light"; localOnly: boolean; optimise: "quality" | "cost" | "latency"; assignments: Partial<Record<TaskKind, string>>;
  defaultStack: string; crawl: Partial<CrawlConfig>; onboarded: boolean; bridgeUrl: string; preferBridge: boolean; autoOpenResults: boolean; sidebarExpanded: boolean;
  github: { login?: string }; vercel: { teamId?: string }; maxCostUsd?: number;
}
export const DEFAULT_SETTINGS: Settings = {
  theme: "dark", localOnly: false, optimise: "quality", assignments: {}, defaultStack: "react-vite", crawl: { mode: "domain", maxDepth: 3, maxPages: 40, concurrency: 4, delayMs: 150, fetchAssets: true, respectRobots: true, followSitemaps: true, includeSubdomains: false, inspectExternal: false, render: false },
  onboarded: false, bridgeUrl: "http://127.0.0.1:4455", preferBridge: true, autoOpenResults: true, sidebarExpanded: false, github: {}, vercel: {},
};

export interface BridgeInfo { version: string; system: { platform: string; arch: string; nativeArch: string; appleSilicon: boolean; rosetta: boolean; cpus: number; memTotalGB: number; memFreeGB: number; hostname: string }; tools: { id: string; name: string; category: string; status: string; path?: string; version?: string; detail?: string; install?: string }[]; clis: any[]; runtimes: { services: any[]; mlx: { available: boolean; detail: string } }; rea: any; chrome: string | null; roots: { id: string; label: string; writable: boolean; path?: string }[] }

interface State {
  ready: boolean;
  settings: Settings;
  projects: ProjectIndexItem[];
  project: Project | null;
  providers: ProviderConfig[];
  models: ModelInfo[];
  modelErrors: { provider: string; error: string }[];
  modelsLoading: boolean;
  jobs: Record<string, LiveJob>;
  bridge: Bridge | null;
  bridgeState: "none" | "checking" | "connected" | "lost";
  bridgeInfo: BridgeInfo | null;
  init(): Promise<void>;
  patchSettings(p: Partial<Settings>): void;
  // projects
  newProject(name: string): Promise<Project>;
  openProject(id: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  mutate(fn: (p: Project) => Project): void;
  importProjectFile(bytes: Uint8Array | string): Promise<void>;
  exportActive(): Uint8Array | null;
  // investigations
  saveInvestigation(inv: Investigation): void;
  removeInvestigation(id: string): void;
  // jobs
  startJob(j: Omit<LiveJob, "startedAt" | "log" | "pages" | "counts" | "progress" | "status">): LiveJob;
  patchJob(id: string, p: Partial<LiveJob>): void;
  logJob(id: string, msg: string, level?: LogEntry["level"]): void;
  cancelJob(id: string): void;
  dismissJob(id: string): void;
  // providers
  setProviders(p: ProviderConfig[]): void;
  setModels(m: ModelInfo[], errors: { provider: string; error: string }[]): void;
  // bridge
  connectBridge(c: BridgeConn): Promise<void>;
  disconnectBridge(): void;
  refreshBridge(force?: boolean): Promise<void>;
}

const persistProject = debounce(async (p: Project) => { await db.set(`project:${p.id}`, p); const idx = await db.get<ProjectIndexItem[]>("projects:index") ?? []; const item: ProjectIndexItem = { id: p.id, name: p.name, updatedAt: p.updatedAt, stats: projectStats(p), localOnly: p.localOnly }; await db.set("projects:index", [item, ...idx.filter((i) => i.id !== p.id)]); useApp.setState((s) => ({ projects: [item, ...s.projects.filter((i) => i.id !== p.id)] })); }, 500);

export const useApp = create<State>((set, get) => ({
  ready: false, settings: DEFAULT_SETTINGS, projects: [], project: null, providers: [], models: [], modelErrors: [], modelsLoading: false, jobs: {}, bridge: null, bridgeState: "none", bridgeInfo: null,

  async init() {
    if (get().ready) return;
    const settings = { ...DEFAULT_SETTINGS, ...ls.get<Partial<Settings>>("omniforge.settings", {}) };
    document.documentElement.setAttribute("data-theme", settings.theme);
    const providers = ls.get<ProviderConfig[]>("omniforge.providers", []);
    let projects = (await db.get<ProjectIndexItem[]>("projects:index")) ?? [];
    let project: Project | null = null;
    const activeId = ls.raw("omniforge.activeProject");
    const id = projects.find((p) => p.id === activeId)?.id ?? projects[0]?.id;
    if (id) project = (await db.get<Project>(`project:${id}`)) ?? null;
    if (!project) { project = createProject("My workspace"); await db.set(`project:${project.id}`, project); projects = [{ id: project.id, name: project.name, updatedAt: project.updatedAt, stats: projectStats(project), localOnly: false }, ...projects]; await db.set("projects:index", projects); }
    // crash/refresh recovery: anything that was still "running" is now "interrupted" (resumable), never lost
    if (project.investigations.some((i) => (i as Investigation).status === "running")) {
      project = { ...project, investigations: project.investigations.map((i) => ((i as Investigation).status === "running" ? ({ ...(i as Investigation), status: "interrupted", finishedAt: new Date().toISOString() } as unknown as typeof i) : i)) };
      await db.set(`project:${project.id}`, project);
    }
    ls.setRaw("omniforge.activeProject", project.id);
    set({ settings, providers, projects, project, ready: true });
    // bridge: desktop app first, else a previously paired companion
    set({ bridgeState: "checking" });
    const t = await tauriBridge();
    if (t) { await get().connectBridge(t); return; }
    const saved = ls.get<BridgeConn | null>("omniforge.bridge", null);
    if (saved && (!saved.expiresAt || saved.expiresAt > Date.now())) {
      const p = await probe(saved.url);
      if (p) { await get().connectBridge(saved); return; }
    }
    set({ bridgeState: "none" });
  },

  patchSettings(p) {
    const prev = get().settings;
    const settings = { ...prev, ...p };
    // keep the last few configurations so "Restore previous settings" can undo a change (settings never contain secrets)
    if (JSON.stringify(prev) !== JSON.stringify(settings)) ls.set("omniforge.settings.history", [prev, ...ls.get<Settings[]>("omniforge.settings.history", [])].slice(0, 8));
    ls.set("omniforge.settings", settings);
    if (p.theme) { document.documentElement.setAttribute("data-theme", p.theme); ls.setRaw("omniforge.theme", p.theme); }
    set({ settings });
  },

  async newProject(name) {
    const p = createProject(name, { localOnly: get().settings.localOnly });
    await db.set(`project:${p.id}`, p);
    const item: ProjectIndexItem = { id: p.id, name: p.name, updatedAt: p.updatedAt, stats: projectStats(p), localOnly: p.localOnly };
    const projects = [item, ...get().projects]; await db.set("projects:index", projects);
    ls.setRaw("omniforge.activeProject", p.id); set({ projects, project: p });
    return p;
  },
  async openProject(id) { persistProject.flush(); const p = await db.get<Project>(`project:${id}`); if (p) { ls.setRaw("omniforge.activeProject", id); set({ project: p }); } },
  async deleteProject(id) {
    await db.del(`project:${id}`);
    let projects = get().projects.filter((p) => p.id !== id); await db.set("projects:index", projects);
    if (get().project?.id === id) { if (projects[0]) await get().openProject(projects[0].id); else { const n = await get().newProject("My workspace"); projects = get().projects; void n; } }
    set({ projects });
  },
  mutate(fn) { const cur = get().project; if (!cur) return; const next = { ...fn(cur), updatedAt: new Date().toISOString() }; set({ project: next }); persistProject(next); },
  async importProjectFile(bytes) {
    const p = coreImport(bytes);
    await db.set(`project:${p.id}`, p);
    const item: ProjectIndexItem = { id: p.id, name: p.name, updatedAt: p.updatedAt, stats: projectStats(p), localOnly: p.localOnly };
    const projects = [item, ...get().projects.filter((i) => i.id !== p.id)]; await db.set("projects:index", projects);
    ls.setRaw("omniforge.activeProject", p.id); set({ projects, project: p });
  },
  exportActive() { const p = get().project; return p ? coreExport(p) : null; },

  saveInvestigation(inv) { get().mutate((p) => upsertInvestigation(p, inv)); },
  removeInvestigation(id) { get().mutate((p) => ({ ...p, investigations: p.investigations.filter((i) => (i as Investigation).id !== id) })); },

  startJob(j) {
    const job: LiveJob = { ...j, status: "running", progress: 0, counts: { pages: 0, assets: 0, evidence: 0 }, log: [], pages: [], startedAt: Date.now() };
    set((s) => ({ jobs: { ...s.jobs, [job.id]: job } }));
    return job;
  },
  patchJob(id, p) { set((s) => (s.jobs[id] ? { jobs: { ...s.jobs, [id]: { ...s.jobs[id]!, ...p } } } : s)); },
  logJob(id, msg, level = "info") { if (level !== "info") appLog.push(level, `job:${get().jobs[id]?.kind ?? "?"}`, msg); set((s) => (s.jobs[id] ? { jobs: { ...s.jobs, [id]: { ...s.jobs[id]!, log: [...s.jobs[id]!.log.slice(-300), { t: new Date().toISOString(), level, msg }] } } } : s)); },
  cancelJob(id) { const j = get().jobs[id]; j?.abort?.abort(); get().patchJob(id, { status: "cancelled", endedAt: Date.now() }); },
  dismissJob(id) { set((s) => { const { [id]: _, ...rest } = s.jobs; return { jobs: rest }; }); },

  setProviders(providers) { ls.set("omniforge.providers", providers.map(({ apiKey: _k, ...r }) => r)); set({ providers: providers.map(({ apiKey: _k, ...r }) => r) }); },
  setModels(models, modelErrors) { set({ models, modelErrors, modelsLoading: false }); },

  async connectBridge(c) {
    const bridge = new Bridge(c);
    set({ bridge, bridgeState: "checking" });
    try {
      const info = await bridge.get<BridgeInfo>("/bridge/info");
      if (c.kind === "session") ls.set("omniforge.bridge", c);
      set({ bridgeInfo: info, bridgeState: "connected" });
      appLog.push("info", "bridge", `connected to ${c.url} (v${info.version})`);
    } catch (e) {
      appLog.push("error", "bridge", `connection failed: ${(e as Error).message}`);
      set({ bridge: null, bridgeInfo: null, bridgeState: "lost" });
      if (c.kind === "session") ls.set("omniforge.bridge", null);
      throw e;
    }
  },
  disconnectBridge() { ls.set("omniforge.bridge", null); set({ bridge: null, bridgeInfo: null, bridgeState: "none" }); },
  async refreshBridge(force) {
    const b = get().bridge; if (!b) return;
    try { set({ bridgeInfo: await b.get<BridgeInfo>(`/bridge/info${force ? "?refresh=1" : ""}`), bridgeState: "connected" }); }
    catch { set({ bridgeState: "lost" }); toast.error("Lost connection to the desktop companion"); }
  },
}));

export const useBridge = () => useApp((s) => s.bridge);
export const isDesktop = isTauri;
export { DEFAULT_CRAWL };
