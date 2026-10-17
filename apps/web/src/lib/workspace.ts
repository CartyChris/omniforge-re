import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "./store";
import { openLocalWorkspace, type LocalWorkspace } from "./localfs";

export type Source = { kind: "browser" } | { kind: "local"; rootId: string; label: string };
export interface WorkspaceApi {
  kind: Source["kind"]; label: string; rootId?: string; loading: boolean; error?: string;
  paths: string[]; get(p: string): string | undefined; set(p: string, c: string): void; add(p: string, c?: string): void; remove(p: string): void; rename(from: string, to: string): void;
  status: "saved" | "saving" | "error"; readonly: Set<string>; skipped: string[]; reload(): void;
}

const norm = (p: string) => p.replace(/^\/+/, "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
export const safeRel = (p: string) => { const n = norm(p); if (!n || n.split("/").some((s) => s === ".." || s === "") || n.length > 500) throw new Error("Use a relative path like src/app.ts"); return n; };

/** One interface over the in-browser project workspace and an approved local folder (desktop). Edits are debounced so typing stays fast. */
export function useWorkspace(source: Source): WorkspaceApi {
  const { project, mutate } = useApp();
  const [tick, setTick] = useState(0); const bump = () => setTick((n) => n + 1);
  const draft = useRef(new Map<string, string | null>()); // pending edits (null = delete)
  const [status, setStatus] = useState<WorkspaceApi["status"]>("saved"); const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [local, setLocal] = useState<LocalWorkspace | null>(null); const [loading, setLoading] = useState(false);
  const rootId = source.kind === "local" ? source.rootId : undefined;

  useEffect(() => {
    setLocal(null); setError(undefined);
    if (!rootId) return; let alive = true; setLoading(true);
    openLocalWorkspace(rootId).then((w) => { if (alive) setLocal(w); }).catch((e) => alive && setError((e as Error).message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [rootId]);

  const commit = useCallback(async () => {
    const d = new Map(draft.current); draft.current.clear(); if (!d.size) return;
    setStatus("saving");
    try {
      if (rootId && local) { for (const [p, c] of d) c === null ? local.fs.remove(p) : local.fs.write(p, c); await local.fs.flush(); }
      else mutate((pr) => { const files = { ...pr.workspace.files }; for (const [p, c] of d) c === null ? delete files[p] : (files[p] = c); return { ...pr, workspace: { ...pr.workspace, files } }; });
      setStatus("saved");
    } catch (e) { setError((e as Error).message); setStatus("error"); }
  }, [rootId, local, mutate]);
  const schedule = useCallback(() => { setStatus("saving"); clearTimeout(timer.current); timer.current = setTimeout(() => void commit(), rootId ? 800 : 350); }, [commit, rootId]);
  useEffect(() => () => { clearTimeout(timer.current); void commit(); }, [commit]);

  const base = useCallback((): Record<string, string> => (rootId ? Object.fromEntries((local?.fs.list() ?? []).map((p) => [p, local!.fs.read(p) ?? ""])) : project?.workspace.files ?? {}), [rootId, local, project?.workspace.files, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const files = useMemo(() => { const b = { ...base() }; for (const [p, c] of draft.current) c === null ? delete b[p] : (b[p] = c); return b; }, [base, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: string, c: string) => { if (local?.fs.readonly.has(p)) return; draft.current.set(p, c); bump(); schedule(); };
  return {
    kind: source.kind, label: source.kind === "local" ? source.label : project?.name ?? "Project", rootId, loading, error, readonly: local?.fs.readonly ?? new Set(), skipped: local?.skipped ?? [],
    paths: Object.keys(files).sort(), get: (p) => files[p], set, add: (p, c = "") => { const r = safeRel(p); if (r in files) throw new Error("That file already exists"); set(r, c); }, remove: (p) => { draft.current.set(p, null); bump(); schedule(); },
    rename: (from, to) => { const t = safeRel(to); if (t in files) throw new Error("A file with that name exists"); const c = files[from]; if (c === undefined) return; draft.current.set(t, c); draft.current.set(from, null); bump(); schedule(); },
    status, reload: () => { if (rootId) { setLocal(null); setLoading(true); openLocalWorkspace(rootId).then(setLocal).catch((e) => setError((e as Error).message)).finally(() => setLoading(false)); } else bump(); },
  };
}
