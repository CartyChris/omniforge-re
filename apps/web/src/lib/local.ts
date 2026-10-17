/** Desktop-only helpers: approved folders, REA jobs, native folder picker. */
import { toast } from "sonner";
import type { Investigation } from "@omniforge/core";
import { uid } from "@omniforge/core";
import { useApp } from "./store";
import { sleep } from "./utils";

export interface RootInfo { id: string; label: string; writable: boolean }
export interface TreeEntry { path: string; type: "dir" | "file"; size?: number }
export interface ReaOpInfo { id: string; label: string; kind: "static" | "native-provider"; accepts: string; platforms?: string[] }

const needBridge = () => { const b = useApp.getState().bridge; if (!b) throw new Error("This needs the OmniForge desktop companion."); return b; };

export const listRoots = () => needBridge().get<RootInfo[]>("/bridge/roots");
export const addRoot = (path: string, o: { label?: string; writable?: boolean } = {}) => needBridge().post<RootInfo>("/bridge/roots", { path, ...o });
export const removeRoot = (id: string) => needBridge().json("DELETE", `/bridge/roots/${id}`);
export const listTree = (root: string, sub?: string) => needBridge().get<{ entries: TreeEntry[]; truncated: boolean }>(`/bridge/fs/tree?root=${encodeURIComponent(root)}${sub ? `&sub=${encodeURIComponent(sub)}` : ""}`);

/** Native folder picker (Tauri only). Returns null on cancel or on the web. */
export async function pickFolderNative(): Promise<string | null> {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<any> } };
  if (!w.__TAURI_INTERNALS__) return null;
  try { return (await w.__TAURI_INTERNALS__.invoke("pick_folder")) ?? null; } catch { return null; }
}

/** Run a REA operation on a path inside an approved root, tracking it as a live job; the result becomes an Investigation. */
export async function runRea(rootId: string, rel: string, op: ReaOpInfo, label: string, approveLaunch = false): Promise<string> {
  const app = useApp.getState(); const jobId = uid("job");
  app.startJob({ id: jobId, kind: "rea", label: `REA · ${op.label} · ${label}`, targets: [label] });
  (async () => {
    const b = needBridge();
    try {
      const meta = await b.post<{ id: string }>("/bridge/rea/jobs", { root: rootId, path: rel, op: op.id, approveLaunch });
      useApp.getState().logJob(jobId, `REA job ${meta.id} started (${op.id})`);
      let last = "";
      for (;;) {
        await sleep(900);
        if (useApp.getState().jobs[jobId]?.status === "cancelled") { await b.post(`/bridge/jobs/${meta.id}/cancel`).catch(() => {}); return; }
        const list = await b.get<{ id: string; state: string; code?: number | null; progress?: { phase: string; completed: number; total: number; message: string } }[]>("/bridge/jobs");
        const j = list.find((x) => x.id === meta.id);
        if (!j) throw new Error("The REA job disappeared (the companion may have restarted).");
        if (j.progress) { const msg = `${j.progress.phase}: ${j.progress.message}`; if (msg !== last) { last = msg; useApp.getState().logJob(jobId, msg); } useApp.getState().patchJob(jobId, { stage: j.progress.phase, progress: j.progress.total ? Math.min(0.95, j.progress.completed / j.progress.total) : 0.4 }); }
        if (j.state !== "running") {
          if (j.state !== "done" || j.code) throw new Error(`REA ended with state “${j.state}”${j.code ? ` (exit ${j.code})` : ""}. Open the job log in Integrations → REA for details.`);
          break;
        }
      }
      const inv = await b.get<Investigation>(`/bridge/rea/jobs/${meta.id}/result?view=investigation`);
      useApp.getState().saveInvestigation(inv);
      useApp.getState().patchJob(jobId, { status: "done", progress: 1, endedAt: Date.now(), investigationId: inv.id, stage: "Done", counts: { pages: 0, assets: inv.files.length, evidence: inv.evidence.length } });
      toast.success(`REA finished: ${inv.features.length} features, ${inv.evidence.length} evidence records`);
    } catch (e) {
      useApp.getState().patchJob(jobId, { status: "error", error: (e as Error).message, endedAt: Date.now() });
      useApp.getState().logJob(jobId, (e as Error).message, "error");
    }
  })();
  return jobId;
}
