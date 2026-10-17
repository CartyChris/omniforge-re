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
    throw new ProviderError(`GitHub ${method} ${path.split("?")[0]} → ${res.status}: ${json.message ?? text.slice(0, 200)}${hint}`, res.status, "github");
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
