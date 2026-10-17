/** Analysis orchestration: websites, uploads, repositories, local folders/packages, REA. */
import { toast } from "sonner";
import { parseRepoRef, parseRepoList, snapshotFromFiles, uid, type CrawlConfig, type Investigation, type RepoSnapshot, type InputFile, type RepoRef, type Assessment } from "@omniforge/core";
import { useApp } from "./store";
import { BridgeError, readNDJSON, readSSE } from "./bridge";

export type InputKind = "website" | "repo" | "mixed" | "empty" | "invalid";
export interface Detected { kind: InputKind; websites: string[]; repos: string[]; invalid: string[] }

/** One omnibox for everything: classify whatever the user pasted. */
export function detectInput(text: string): Detected {
  const toks = text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
  const websites: string[] = [], repos: string[] = [], invalid: string[] = [];
  for (const t of toks) {
    if (/^(?:https?:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com)\//i.test(t) || /^git@(?:github|gitlab)\.com:/i.test(t) || (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(t) && !/\.[a-z]{2,}\//i.test(t) && !t.includes("."))) {
      try { parseRepoRef(t); repos.push(t); } catch { invalid.push(t); }
    } else if (/^https?:\/\//i.test(t)) websites.push(t);
    else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(t)) websites.push(`https://${t}`);
    else if (/^(?:localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/i.test(t)) websites.push(`http://${t}`);
    else invalid.push(t);
  }
  const kind: InputKind = !toks.length ? "empty" : websites.length && repos.length ? "mixed" : websites.length ? "website" : repos.length ? "repo" : "invalid";
  return { kind, websites, repos, invalid };
}

const apiBase = () => "";
function endpoint(path: "analyze"): { url: string; init: (body: unknown, signal: AbortSignal) => RequestInit; viaBridge: boolean } {
  const { bridge, settings } = useApp.getState();
  if (bridge && settings.preferBridge) return { url: `${bridge.conn.url}/bridge/${path}`, viaBridge: true, init: (b, signal) => ({ method: "POST", signal, headers: { "content-type": "application/json", authorization: `Bearer ${bridge.conn.token}`, "x-omniforge-bridge": "1" }, body: JSON.stringify(b) }) };
  return { url: `${apiBase()}/api/${path}`, viaBridge: false, init: (b, signal) => ({ method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(b) }) };
}

export function friendlyError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/loopback|private|internal name|link-local|127\.0\.0\.1|localhost/i.test(m)) return `${m}\n\nLocal and private addresses can only be analysed with the OmniForge desktop companion (Settings → Desktop companion).`;
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Could not reach the analysis service. Check your connection (or, on the hosted app, whether the deployment is up).";
  return m;
}

/* ------------------------------ websites ------------------------------ */

export async function analyzeWebsites(targets: string[], config: Partial<CrawlConfig> = {}, o: { name?: string; resume?: Investigation } = {}): Promise<string> {
  const app = useApp.getState();
  const jobId = uid("job");
  const abort = new AbortController();
  const cfg = { ...app.settings.crawl, ...config };
  const label = o.name ?? (targets.length > 1 ? `${new URL(targets[0]!).host} + ${targets.length - 1} more` : new URL(targets[0]!).host);
  app.startJob({ id: jobId, kind: "web", label, targets, abort });
  const ep = endpoint("analyze");
  app.logJob(jobId, `Starting analysis via ${ep.viaBridge ? "desktop companion" : "hosted service"}`);
  let stubId: string | undefined;
  (async () => {
    try {
      const res = await fetch(ep.url, ep.init({ targets, config: cfg, name: o.name }, abort.signal));
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${res.status}`); }
      await readSSE(res, (ev, d) => {
        const st = useApp.getState();
        if (ev === "update") {
          if (!stubId) {
            stubId = d.id;
            st.patchJob(jobId, { investigationId: d.id });
            st.saveInvestigation({ id: d.id, name: label, targets: targets.map((value) => ({ id: uid("tg"), kind: targets.length > 1 ? "urls" : "url", value, addedAt: new Date().toISOString() })), config: { ...(cfg as CrawlConfig) }, status: "running", startedAt: new Date().toISOString(), progress: 0, pages: [], assets: [], technologies: [], files: [], dependencies: [], endpoints: [], features: [], findings: [], evidence: [], graph: { nodes: [], edges: [] }, coverage: { score: 0, checks: [] }, limitations: [], questions: [], log: [] });
          }
          const cur = st.jobs[jobId];
          st.patchJob(jobId, { progress: d.progress, counts: d.counts, pages: [...(cur?.pages ?? []), ...d.pages].slice(-600), stage: d.progress < 0.55 ? "Crawling pages" : d.progress < 0.82 ? "Analysing assets" : "Interpreting" });
          for (const l of d.log ?? []) st.logJob(jobId, l.msg, l.level);
        } else if (ev === "done") {
          st.saveInvestigation(d as Investigation);
          st.patchJob(jobId, { status: "done", progress: 1, endedAt: Date.now(), investigationId: d.id, stage: "Done", counts: { pages: d.pages.length, assets: d.assets.length, evidence: d.evidence.length } });
          toast.success(`Analysis complete: ${d.pages.length} pages, ${d.technologies.length} technologies`);
        } else if (ev === "error") throw new Error(d.message);
      }, abort.signal);
      if (useApp.getState().jobs[jobId]?.status === "running") useApp.getState().patchJob(jobId, { status: "error", error: "The connection ended before the analysis finished." });
    } catch (e) {
      const st = useApp.getState();
      if ((e as Error).name === "AbortError") {
        if (stubId) st.mutate((p) => ({ ...p, investigations: p.investigations.map((i) => ((i as Investigation).id === stubId ? ({ ...(i as Investigation), status: "cancelled" } as unknown as typeof i) : i)) }));
        return;
      }
      const msg = friendlyError(e);
      st.patchJob(jobId, { status: "error", error: msg, endedAt: Date.now() });
      st.logJob(jobId, msg, "error");
      if (stubId) st.mutate((p) => ({ ...p, investigations: p.investigations.map((i) => ((i as Investigation).id === stubId ? ({ ...(i as Investigation), status: "error" } as unknown as typeof i) : i)) }));
    }
  })();
  return jobId;
}

/* ------------------------------ uploads ------------------------------ */

let worker: Worker | null = null;
const getWorker = () => (worker ??= new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" }));

export interface PickedFile { path: string; file: File }

/** Normalise <input type=file>, directory pickers and drag-drop (incl. folders) into path+File pairs. */
export async function collectFiles(items: DataTransferItemList | FileList | File[]): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  if ("length" in items && items.length && (items as FileList)[0] instanceof File) {
    for (const f of Array.from(items as FileList)) out.push({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f });
    return out;
  }
  const walk = async (entry: any, prefix: string): Promise<void> => {
    if (entry.isFile) await new Promise<void>((res) => entry.file((f: File) => { out.push({ path: prefix + f.name, file: f }); res(); }, () => res()));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch: any[] = await new Promise((res) => reader.readEntries(res, () => res([])));
        if (!batch.length) break;
        for (const e of batch) { if (out.length > 30_000) return; if (!/^(node_modules|\.git)$/.test(e.name)) await walk(e, `${prefix}${entry.name}/`); }
      }
    }
  };
  const list = Array.from(items as DataTransferItemList);
  const entries = list.map((i) => (i as DataTransferItem).webkitGetAsEntry?.()).filter(Boolean);
  for (const e of entries) await walk(e, "");
  if (!entries.length) for (const i of list) { const f = (i as DataTransferItem).getAsFile?.(); if (f) out.push({ path: f.name, file: f }); }
  // folders dropped as a single directory come back prefixed with the directory name; strip a lone common root
  return out;
}

export async function analyzeFiles(picked: PickedFile[], name?: string): Promise<string> {
  const app = useApp.getState();
  const jobId = uid("job");
  const label = name ?? (picked.length === 1 ? picked[0]!.path : `${picked.length} files`);
  app.startJob({ id: jobId, kind: "source", label, targets: picked.slice(0, 5).map((p) => p.path) });
  app.patchJob(jobId, { stage: "Reading files", progress: 0.1 });
  (async () => {
    try {
      const total = picked.reduce((n, p) => n + p.file.size, 0);
      if (total > 600_000_000) throw new Error("That is more than 600 MB. Analyse a smaller folder, or use the desktop companion for large trees.");
      const files: { path: string; data: ArrayBuffer }[] = [];
      for (const p of picked.slice(0, 40_000)) files.push({ path: p.path, data: await p.file.arrayBuffer() });
      const id = uid("w");
      const kind = picked.length === 1 ? "archive" : "folder";
      const w = getWorker();
      const inv = await new Promise<Investigation>((resolve, reject) => {
        const onMsg = (e: MessageEvent) => {
          if (e.data.id !== id) return;
          if (e.data.type === "progress") { useApp.getState().logJob(jobId, e.data.message); useApp.getState().patchJob(jobId, { stage: e.data.message, progress: 0.5 }); }
          else if (e.data.type === "done") { w.removeEventListener("message", onMsg); resolve(e.data.inv); }
          else if (e.data.type === "error") { w.removeEventListener("message", onMsg); reject(new Error(e.data.message)); }
        };
        w.addEventListener("message", onMsg);
        w.postMessage({ id, name: label, kind, origin: label, files }, files.map((f) => f.data));
      });
      useApp.getState().saveInvestigation(inv);
      useApp.getState().patchJob(jobId, { status: "done", progress: 1, endedAt: Date.now(), investigationId: inv.id, stage: "Done", counts: { pages: 0, assets: inv.files.length, evidence: inv.evidence.length } });
      toast.success(`Analysed ${inv.files.length} files · ${inv.technologies.length} technologies`);
    } catch (e) {
      useApp.getState().patchJob(jobId, { status: "error", error: (e as Error).message, endedAt: Date.now() });
    }
  })();
  return jobId;
}

/* ------------------------------ repositories ------------------------------ */

export interface RepoSummary { ok: true; url: string; ref: RepoRef; sha?: string; defaultBranch?: string; description?: string; stars?: number; isPrivate?: boolean; licenses: any[]; effective: { spdx: string; class: string; source: string }; files: number; bytes: number; skipped: number; languages: { language: string; files: number; lines: number }[]; frameworks: string[]; buildSystems: string[]; entrypoints: string[]; routes: number; components: number; dependencies: number; envVars: string[]; database: { kind: string; path: string; detail: string }[]; tree: string[] }
export type RepoResult = RepoSummary | { ok: false; url: string; error: string };
export interface RepoInspect { repos: RepoResult[]; assessment: Assessment | null }

export async function inspectRepos(urls: string[], o: { token?: string; purpose?: "clone" | "port" | "mesh" } = {}): Promise<RepoInspect> {
  const { bridge, settings } = useApp.getState();
  const useBridge = !!bridge && settings.preferBridge;
  const res = useBridge ? await bridge!.raw("POST", "/bridge/repo/inspect", { urls, token: o.token, purpose: o.purpose }) : await fetch(`${apiBase()}/api/repo/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ urls, token: o.token, purpose: o.purpose }) });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${res.status}`); }
  return res.json();
}

/** Download a repo's files (streamed NDJSON) into a snapshot usable by the Repo Rip engine. */
export async function fetchRepoSnapshot(url: string, o: { token?: string; onProgress?: (n: number, total: number) => void; signal?: AbortSignal } = {}): Promise<RepoSnapshot> {
  const { bridge, settings } = useApp.getState();
  const useBridge = !!bridge && settings.preferBridge;
  const res = useBridge ? await bridge!.raw("POST", "/bridge/repo/files", { url, token: o.token }, o.signal) : await fetch(`${apiBase()}/api/repo/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, token: o.token }), signal: o.signal });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${res.status}`); }
  let header: any = null; const files: InputFile[] = [];
  await readNDJSON(res, (l) => { if (l.header) header = l.header; else { const bin = atob(l.b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); files.push({ path: l.path, data: u8 }); o.onProgress?.(files.length, header?.count ?? 0); } });
  const ref = header?.ref ?? parseRepoRef(url);
  const snap = await snapshotFromFiles(ref, files, { method: header?.method ?? "tarball", sha: header?.sha, defaultBranch: header?.defaultBranch, description: header?.description, stars: header?.stars }, { subdir: undefined });
  snap.skipped.push(...(header?.skipped ?? []));
  return snap;
}

/* ------------------------------ desktop-only ------------------------------ */

export async function analyzeLocalFolder(rootId: string, label: string): Promise<string> {
  const app = useApp.getState(); const jobId = uid("job");
  app.startJob({ id: jobId, kind: "folder", label, targets: [label] });
  app.patchJob(jobId, { stage: "Reading folder", progress: 0.3 });
  try {
    const inv = await app.bridge!.post<Investigation>("/bridge/analyze-folder", { root: rootId });
    useApp.getState().saveInvestigation(inv);
    useApp.getState().patchJob(jobId, { status: "done", progress: 1, investigationId: inv.id, endedAt: Date.now(), counts: { pages: 0, assets: inv.files.length, evidence: inv.evidence.length } });
  } catch (e) { useApp.getState().patchJob(jobId, { status: "error", error: (e as Error).message, endedAt: Date.now() }); }
  return jobId;
}

export async function inspectLocalPackage(rootId: string, rel: string, label: string): Promise<{ jobId: string; report?: any }> {
  const app = useApp.getState(); const jobId = uid("job");
  app.startJob({ id: jobId, kind: "package", label, targets: [label] });
  app.patchJob(jobId, { stage: "Inspecting package", progress: 0.3 });
  try {
    const r = await app.bridge!.post<{ report: any; investigation: Investigation | null }>("/bridge/inspect-package", { root: rootId, path: rel });
    if (r.investigation) useApp.getState().saveInvestigation(r.investigation);
    useApp.getState().patchJob(jobId, { status: "done", progress: 1, investigationId: r.investigation?.id, endedAt: Date.now(), counts: { pages: 0, assets: r.report.files?.length ?? 0, evidence: 0 } });
    return { jobId, report: r.report };
  } catch (e) { useApp.getState().patchJob(jobId, { status: "error", error: (e as Error).message, endedAt: Date.now() }); return { jobId }; }
}

export { parseRepoList, BridgeError };
