/** Repository references: GitHub, GitLab and generic git URLs. */
export interface RepoRef {
  host: "github" | "gitlab" | "other";
  owner: string;
  repo: string;
  ref?: string; // branch, tag or sha
  subdir?: string;
  cloneUrl: string;
  webUrl: string;
  slug: string; // filesystem-safe name
}

export class RepoRefError extends Error {}

const SEG = /^[A-Za-z0-9._-]+$/;

export function parseRepoRef(input: string): RepoRef {
  let s = input.trim().replace(/\.git(?=$|[#?/])/, "").replace(/\/+$/, "");
  if (!s) throw new RepoRefError("Enter a repository URL or owner/repo");
  // owner/repo shorthand → GitHub
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:#[\w./-]+)?$/.test(s)) s = `https://github.com/${s}`;
  s = s.replace(/^git@github\.com:/, "https://github.com/").replace(/^git@gitlab\.com:/, "https://gitlab.com/").replace(/^github\.com\//, "https://github.com/").replace(/^gitlab\.com\//, "https://gitlab.com/");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new RepoRefError(`Not a repository URL: ${input}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new RepoRefError("Only https:// repository URLs are supported");
  if (u.username || u.password) throw new RepoRefError("Do not put credentials in the URL; add a token in Integrations instead");
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  const hash = u.hash.replace(/^#/, "");
  if (host === "github.com" || host === "www.github.com") {
    const [owner, repo, kind, ...rest] = parts;
    if (!owner || !repo || !SEG.test(owner) || !SEG.test(repo)) throw new RepoRefError("Expected https://github.com/owner/repo");
    let ref: string | undefined = hash || undefined;
    let subdir: string | undefined;
    if ((kind === "tree" || kind === "blob") && rest.length) {
      ref = rest[0];
      subdir = rest.slice(1).join("/") || undefined;
    }
    return { host: "github", owner, repo, ref, subdir, cloneUrl: `https://github.com/${owner}/${repo}.git`, webUrl: `https://github.com/${owner}/${repo}`, slug: `${owner}-${repo}`.toLowerCase() };
  }
  if (host === "gitlab.com") {
    const dash = parts.indexOf("-");
    const path = dash >= 0 ? parts.slice(0, dash) : parts;
    if (path.length < 2 || !path.every((p) => SEG.test(p))) throw new RepoRefError("Expected https://gitlab.com/group/project");
    let ref: string | undefined = hash || undefined;
    let subdir: string | undefined;
    if (dash >= 0 && (parts[dash + 1] === "tree" || parts[dash + 1] === "blob") && parts[dash + 2]) {
      ref = parts[dash + 2];
      subdir = parts.slice(dash + 3).join("/") || undefined;
    }
    const repo = path[path.length - 1]!;
    const owner = path.slice(0, -1).join("/");
    return { host: "gitlab", owner, repo, ref, subdir, cloneUrl: `https://gitlab.com/${path.join("/")}.git`, webUrl: `https://gitlab.com/${path.join("/")}`, slug: path.join("-").toLowerCase() };
  }
  const repo = parts[parts.length - 1];
  if (!repo) throw new RepoRefError("Could not find a repository path in that URL");
  return { host: "other", owner: parts.slice(0, -1).join("/"), repo, ref: hash || undefined, cloneUrl: `${u.origin}${u.pathname.replace(/\/$/, "")}.git`, webUrl: `${u.origin}${u.pathname}`, slug: `${host}-${parts.join("-")}`.toLowerCase().replace(/[^a-z0-9-]/g, "-") };
}

export function parseRepoList(text: string): { refs: RepoRef[]; errors: { line: string; error: string }[] } {
  const refs: RepoRef[] = [];
  const errors: { line: string; error: string }[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,;\s]+/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const r = parseRepoRef(line);
      const k = `${r.cloneUrl}#${r.ref ?? ""}#${r.subdir ?? ""}`;
      if (!seen.has(k)) { seen.add(k); refs.push(r); }
    } catch (e) {
      errors.push({ line, error: (e as Error).message });
    }
  }
  return { refs, errors };
}
