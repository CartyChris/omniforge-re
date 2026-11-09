/** The AI Chat orchestrator's side effects, done with the app's own pipelines: the same jobs, workers and approvals as the UI. */
import { buildRebuildPlan, parseRepoRef, REBUILD_MODES, stackById, type Investigation, type ReaHost } from "@omniforge/core";
import { useApp } from "./store";
import { analyzeFiles, analyzeWebsites, fetchRepoSnapshot, type PickedFile } from "./analyze";
import { requestApproval } from "./approvals";
import { runPlan } from "./ai";

const investigations = () => (useApp.getState().project?.investigations ?? []) as unknown as Investigation[];

/** Resolve when a background analysis job finishes (its investigation), reject on error/cancel; aborting cancels the job. */
export function waitForJob(jobId: string, signal?: AbortSignal): Promise<Investigation> {
  return new Promise((resolve, reject) => {
    let unsub = () => {};
    const onAbort = () => { unsub(); useApp.getState().jobs[jobId]?.abort?.abort(); reject(new DOMException("Aborted", "AbortError")); };
    const check = () => {
      const j = useApp.getState().jobs[jobId]; if (!j || j.status === "running") return false;
      unsub(); signal?.removeEventListener("abort", onAbort);
      if (j.status === "done") { const inv = investigations().find((i) => i.id === j.investigationId); if (inv) resolve(inv); else reject(new Error("The analysis finished without a result.")); }
      else reject(new Error(j.error ?? `Analysis ${j.status}`));
      return true;
    };
    if (signal?.aborted) return onAbort();
    if (check()) return;
    unsub = useApp.subscribe(() => void check());
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function chatHost(attached: PickedFile[]): ReaHost {
  return {
    investigations,
    attachments: () => attached.map((f) => ({ name: f.path, bytes: f.file.size })),
    async analyzeUrl(url, o) { return waitForJob(await analyzeWebsites([url], { maxPages: o.maxPages }), o.signal); },
    async analyzeRepo(url, o) {
      const ref = parseRepoRef(url);
      const snap = await fetchRepoSnapshot(url, { signal: o.signal });
      if (!snap.files.length) throw new Error(`No files could be downloaded from ${ref.owner}/${ref.repo}.`);
      const picked: PickedFile[] = snap.files.map((f) => ({ path: f.path, file: new File([f.data as BlobPart], f.path.split("/").pop() || "file") }));
      return waitForJob(await analyzeFiles(picked, `${ref.owner}/${ref.repo}`), o.signal);
    },
    async analyzeAttachments(o) {
      if (!attached.length) throw new Error("No files are attached to this conversation.");
      return waitForJob(await analyzeFiles(attached, attached.length === 1 ? attached[0]!.path : `${attached.length} attached files`), o.signal);
    },
    async rebuild(o) {
      const inv = investigations().find((i) => i.id === o.investigationId); if (!inv) throw new Error("Investigation not found.");
      const tasks = buildRebuildPlan({ inv, mode: o.mode, stackId: o.stackId, featureIds: o.featureIds, improvements: o.improvements });
      const mode = REBUILD_MODES.find((m) => m.id === o.mode)!; const stack = stackById(o.stackId);
      const okd = await requestApproval({ kind: "write", title: `Rebuild “${inv.name}” with AI agents?`, detail: `${mode.label} in ${stack.label}: ${tasks.length} agent tasks write files into this project's Code Workspace using your connected models (this uses provider credits). Nothing is deployed.` });
      if (!okd) return "The user declined the rebuild. Nothing was built.";
      const res = await runPlan(tasks, { onUpdate: () => {}, signal: o.signal });
      const files = [...new Set(res.flatMap((t) => t.files ?? []))];
      const failed = res.filter((t) => t.status !== "done");
      return `Rebuild finished: ${res.length - failed.length}/${res.length} tasks done${failed.length ? ` (not done: ${failed.map((t) => `${t.objective.slice(0, 60)} — ${t.status}`).join("; ")})` : ""}. ${files.length} file(s) written to the Code Workspace: ${files.slice(0, 40).join(", ")}${files.length > 40 ? ", …" : ""}.`;
    },
  };
}
