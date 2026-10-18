import { create } from "zustand";
import { audit } from "./audit";

export interface ApprovalRequest { id: string; title: string; detail: string; kind: "command" | "install" | "launch" | "write" | "deploy" | "publish" | "other"; command?: string; danger?: boolean; resolve: (ok: boolean) => void }
interface S { queue: ApprovalRequest[]; push(r: Omit<ApprovalRequest, "id" | "resolve">): Promise<boolean>; settle(id: string, ok: boolean): void }

/** Anything that executes code, installs, deploys or publishes must pass through here — nothing runs silently. */
export const useApprovals = create<S>((set, get) => ({
  queue: [],
  push(r) { return new Promise<boolean>((resolve) => set((s) => ({ queue: [...s.queue, { ...r, id: Math.random().toString(36).slice(2), resolve }] }))); },
  settle(id, ok) { const r = get().queue.find((q) => q.id === id); if (r) void audit(ok ? "approved" : "denied", `${r.kind}: ${r.title}${r.command ? ` — ${r.command}` : ""}`); r?.resolve(ok); set((s) => ({ queue: s.queue.filter((q) => q.id !== id) })); },
}));
export const requestApproval = (r: Omit<ApprovalRequest, "id" | "resolve">) => useApprovals.getState().push(r);
