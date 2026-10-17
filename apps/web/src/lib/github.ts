/** GitHub / Vercel credentials live only in the vault (Keychain on desktop); these helpers fetch them and run the commits. */
import { github, vercel, type AgentTask } from "@omniforge/core";
import { vault } from "./vault";
import { smartFetch } from "./net";
import { useApp } from "./store";
import { requestApproval } from "./approvals";

export const GH_KEY = "token:github";
export const VC_KEY = "token:vercel";
const fetcher = () => smartFetch(() => useApp.getState().bridge);
export const appFetch = () => fetcher();

export async function ghToken(): Promise<string | undefined> { try { return await vault.get(GH_KEY); } catch { return undefined; } }
export async function vcToken(): Promise<string | undefined> { try { return await vault.get(VC_KEY); } catch { return undefined; } }
export const ghOpts = async () => { const token = await ghToken(); if (!token) throw new Error("Connect GitHub first (Integrations → GitHub)."); return { token, fetch: fetcher() }; };
export const vcOpts = async () => { const token = await vcToken(); if (!token) throw new Error("Connect Vercel first (Integrations → Vercel)."); return { token, teamId: useApp.getState().settings.vercel.teamId, fetch: fetcher() }; };

/** Create a repo and commit files to it — only after the user explicitly approves exactly what will be published. */
export async function publishToGitHub(name: string, files: { path: string; data: Uint8Array | string }[], o: { private?: boolean; description?: string; message?: string; existing?: string } = {}) {
  const gh = await ghOpts();
  const ok = await requestApproval({ kind: "publish", title: o.existing ? `Commit to ${o.existing}?` : `Create GitHub repository “${name}”?`, detail: `${files.length} files will be sent to GitHub${o.private === false ? " in a PUBLIC repository" : " in a private repository"}. Secrets are never included, but review licensing first.` });
  if (!ok) throw new Error("Publishing cancelled.");
  let full = o.existing;
  if (!full) { const r = await github.createRepo(gh, name, { private: o.private !== false, description: o.description }); full = r.full_name; }
  const c = await github.commitFiles(gh, full!, files, { message: o.message ?? "Initial commit from OmniForge RE" });
  return { repo: full!, url: `https://github.com/${full}`, commit: c };
}

export const taskDone = (t: AgentTask[]) => t.every((x) => ["done", "skipped"].includes(x.status));
export { vercel };
