/**
 * GitHub REST integration (user-supplied token, official API only):
 * create repo, commit a whole tree in ONE commit via the Git Data API (handles
 * binaries), branches, pull requests, repo listing.
 */
import { ProviderError } from "../ai/types.js";

export interface GhOptions { token: string; fetch?: typeof fetch; api?: string }
export interface GhFile { path: string; data: Uint8Array | string }

const b64 = (d: Uint8Array | string) => {
  const bytes = typeof d === "string" ? new TextEncoder().encode(d) : d;
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function gh<T>(o: GhOptions, method: string, path: string, body?: unknown): Promise<T> {
  const res = await (o.fetch ?? fetch)(`${o.api ?? "https://api.github.com"}${path}`, {
    method,
    headers: { authorization: `Bearer ${o.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "OmniForgeRE" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
  if (!res.ok) {
    const hint = res.status === 401 ? " (token invalid or expired)" : res.status === 403 ? " (token lacks permission: it needs repo/contents write access)" : res.status === 422 && /name already exists/i.test(text) ? " (a repository with that name already exists)" : "";
    const detail = Array.isArray(json.errors) ? json.errors.map((x: any) => x?.message).filter(Boolean).join("; ") : "";
    throw new ProviderError(`GitHub ${method} ${path.split("?")[0]} → ${res.status}: ${json.message ?? text.slice(0, 200)}${detail ? ` — ${detail}` : ""}${hint}`, res.status, "github");
  }
  return json as T;
}

export async function whoami(o: GhOptions) {
  const u = await gh<{ login: string; name?: string }>(o, "GET", "/user");
  return { login: u.login, name: u.name };
}

export async function listRepos(o: GhOptions, limit = 50) {
  const r = await gh<any[]>(o, "GET", `/user/repos?per_page=${Math.min(limit, 100)}&sort=pushed`);
  return r.map((x) => ({ full_name: x.full_name as string, private: !!x.private, default_branch: x.default_branch as string, url: x.html_url as string }));
}

export async function createRepo(o: GhOptions, name: string, opts: { private?: boolean; description?: string } = {}) {
  const r = await gh<any>(o, "POST", "/user/repos", { name, private: opts.private ?? true, description: opts.description ?? "Created with OmniForge RE", auto_init: false });
  return { full_name: r.full_name as string, url: r.html_url as string, default_branch: (r.default_branch as string) ?? "main", clone_url: r.clone_url as string };
}

/**
 * Commit `files` as one commit on `branch`. Works for empty repos (creates the
 * branch) and existing ones (parent = current head). Returns the commit sha and URL.
 */
export async function commitFiles(o: GhOptions, repo: string, files: GhFile[], opts: { branch?: string; message: string; baseBranch?: string; authorName?: string; authorEmail?: string }) {
  const branch = opts.branch ?? "main";
  // Empty repositories have no refs; the contents API can seed one file so git-data calls work.
  let parent: string | undefined;
  try {
    const ref = await gh<any>(o, "GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    parent = ref.object.sha;
  } catch (e) {
    if ((e as ProviderError).status !== 404 && (e as ProviderError).status !== 409) throw e;
    if (opts.baseBranch) {
      const base = await gh<any>(o, "GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(opts.baseBranch)}`);
      parent = base.object.sha;
    }
  }
  let seeded = false;
  if (!parent) {
    try {
      await gh<any>(o, "GET", `/repos/${repo}/commits?per_page=1`);
    } catch (e) {
      if ((e as ProviderError).status === 409 || (e as ProviderError).status === 404) {
        const seed = await gh<any>(o, "PUT", `/repos/${repo}/contents/.omniforge-init`, { message: "Initialize repository", content: b64("init\n"), branch });
        parent = seed.commit.sha;
        seeded = true;
      } else throw e;
    }
  }
  const blobs = [] as { path: string; sha: string }[];
  for (const f of files) {
    const blob = await gh<{ sha: string }>(o, "POST", `/repos/${repo}/git/blobs`, { content: b64(f.data), encoding: "base64" });
    blobs.push({ path: f.path, sha: blob.sha });
  }
  const baseTree = parent ? (await gh<any>(o, "GET", `/repos/${repo}/git/commits/${parent}`)).tree.sha : undefined;
  const tree = await gh<{ sha: string }>(o, "POST", `/repos/${repo}/git/trees`, { base_tree: baseTree, tree: blobs.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha })) });
  const commit = await gh<{ sha: string; html_url: string }>(o, "POST", `/repos/${repo}/git/commits`, { message: opts.message, tree: tree.sha, parents: parent ? [parent] : [], ...(opts.authorName ? { author: { name: opts.authorName, email: opts.authorEmail ?? "noreply@example.com" } } : {}) });
  const exists = !!parent && !!(await gh<any>(o, "GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`).catch(() => null));
  if (exists) await gh(o, "PATCH", `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
  else await gh(o, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  return { sha: commit.sha, url: commit.html_url ?? `https://github.com/${repo}/commit/${commit.sha}`, branch, files: files.length, seeded };
}

export async function createBranch(o: GhOptions, repo: string, name: string, from: string) {
  const base = await gh<any>(o, "GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(from)}`);
  await gh(o, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${name}`, sha: base.object.sha });
  return { branch: name, sha: base.object.sha as string };
}

export async function createPullRequest(o: GhOptions, repo: string, p: { title: string; head: string; base: string; body?: string }) {
  const r = await gh<any>(o, "POST", `/repos/${repo}/pulls`, p);
  return { number: r.number as number, url: r.html_url as string };
}

/** Git refname rules that matter in practice; returns the problem, or null when the name is usable. */
export function branchNameProblem(name: string): string | null {
  if (!name.trim()) return "Enter a branch name.";
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return "Branch names cannot contain spaces or any of ~ ^ : ? * [ \\.";
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock") || name.includes("..") || name.includes("//") || name.includes("@{") || name === "@") return "That is not a valid git branch name.";
  if (name.split("/").some((s) => s.startsWith(".") || s.endsWith(".lock"))) return "Branch name parts cannot start with “.” or end with “.lock”.";
  return null;
}

/**
 * Branch + commit + pull request in one step, never touching the base branch. Adds/updates the given files
 * (files absent from `files` are left as they are on the base — GitHub's tree API is additive here).
 */
export async function openPullRequest(o: GhOptions, repo: string, p: { files: GhFile[]; branch: string; base: string; title: string; body?: string; message?: string }) {
  const bad = branchNameProblem(p.branch);
  if (bad) throw new Error(bad);
  if (p.branch === p.base) throw new Error("The pull-request branch must differ from the base branch — it would otherwise commit straight to it.");
  if (!p.title.trim()) throw new Error("Give the pull request a title.");
  if (!p.files.length) throw new Error("There are no files to include.");
  try { await gh(o, "GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(p.base)}`); } catch (e) {
    if ((e as ProviderError).status === 404 || (e as ProviderError).status === 409) throw new Error(`The base branch “${p.base}” does not exist in ${repo}.`);
    throw e;
  }
  const commit = await commitFiles(o, repo, p.files, { branch: p.branch, baseBranch: p.base, message: p.message?.trim() || p.title.trim() });
  const pr = await createPullRequest(o, repo, { title: p.title.trim(), head: p.branch, base: p.base, body: p.body });
  return { ...pr, commit };
}
