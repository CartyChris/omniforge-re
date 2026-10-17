/**
 * Locked-down git: clone public/token-authenticated repos safely and run
 * status/diff/commit inside approved roots.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BlockedUrlError, parseRepoRef, validateUrl, filterFiles, type InputFile, type RepoRef, type RepoSnapshot, snapshotFromFiles } from "@omniforge/core";
import { nodeResolver } from "../net.js";
import { UserError } from "../http.js";
import { sanitizedEnv } from "./jobs.js";

const run = (args: string[], o: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; maxBuffer?: number } = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile("git", args, { cwd: o.cwd, timeout: o.timeoutMs ?? 120_000, maxBuffer: o.maxBuffer ?? 20_000_000, env: sanitizedEnv({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", GIT_CONFIG_NOSYSTEM: "1", ...o.env }) }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });

export async function gitVersion(): Promise<string | null> {
  const r = await run(["--version"], { timeoutMs: 5000 });
  return r.code === 0 ? r.stdout.trim().replace(/^git version /, "") : null;
}

const hardening = (allowFile: boolean) => ["-c", `protocol.file.allow=${allowFile ? "always" : "never"}`, "-c", "protocol.ext.allow=never", "-c", "protocol.git.allow=never", "-c", "core.symlinks=false", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false"];

export interface CloneOptions { ref?: string; token?: string; depth?: number; timeoutMs?: number; allowPrivate?: boolean; /** tests only */ allowLocalPath?: boolean; maxBytes?: number }

/** Shallow, hardened clone into a fresh temp dir. Returns the dir (caller deletes it). */
export async function cloneRepo(url: string, o: CloneOptions = {}): Promise<{ dir: string; sha: string | null; branch: string | null }> {
  let target = url;
  if (!o.allowLocalPath) {
    const u = validateUrl(url, { allowPrivate: o.allowPrivate });
    if (u.protocol !== "https:") throw new BlockedUrlError("Only https:// git URLs are cloned", "scheme");
    if (!o.allowPrivate) {
      for (const a of await nodeResolver(u.hostname).catch(() => [] as string[])) {
        const { privateIpReason } = await import("@omniforge/core");
        if (privateIpReason(a)) throw new BlockedUrlError(`${u.hostname} resolves to a non-public address`, "private-ip");
      }
    }
    target = u.toString();
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omniforge-clone-"));
  const auth = o.token ? ["-c", `http.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${o.token}`).toString("base64")}`] : [];
  const args = [...hardening(!!o.allowLocalPath), ...auth, "clone", "--depth", String(o.depth ?? 1), "--no-tags", "--single-branch", ...(o.ref ? ["--branch", o.ref] : []), "--", target, dir];
  const r = await run(args, { timeoutMs: o.timeoutMs ?? 300_000 });
  if (r.code !== 0) {
    await fs.rm(dir, { recursive: true, force: true });
    const msg = r.stderr.replace(/Authorization: Basic [A-Za-z0-9+/=]+/g, "[REDACTED]").trim().split("\n").slice(-3).join(" ");
    throw new UserError(/not found|Authentication failed|could not read Username/i.test(msg) ? "Repository not found, or it is private and needs a token." : `git clone failed: ${msg}`);
  }
  const sha = (await run(["rev-parse", "HEAD"], { cwd: dir, timeoutMs: 10_000 })).stdout.trim() || null;
  const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, timeoutMs: 10_000 })).stdout.trim() || null;
  return { dir, sha, branch };
}

/** Read a cloned/working dir into memory, skipping .git, symlinks and oversize files. */
export async function readDir(dir: string, o: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number } = {}): Promise<{ files: InputFile[]; skipped: { path: string; reason: string }[] }> {
  const files: InputFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let total = 0;
  async function walk(d: string) {
    for (const it of await fs.readdir(d, { withFileTypes: true })) {
      if (it.name === ".git") continue;
      const full = path.join(d, it.name);
      const rel = path.relative(dir, full).split(path.sep).join("/");
      if (it.isSymbolicLink()) { skipped.push({ path: rel, reason: "symlink (not followed)" }); continue; }
      if (it.isDirectory()) { await walk(full); continue; }
      if (!it.isFile()) continue;
      const st = await fs.stat(full);
      if (files.length >= (o.maxFiles ?? 30_000)) { skipped.push({ path: rel, reason: "file-count limit" }); continue; }
      if (st.size > (o.maxFileBytes ?? 30_000_000)) { skipped.push({ path: rel, reason: "file too large" }); continue; }
      if (total + st.size > (o.maxTotalBytes ?? 1_000_000_000)) { skipped.push({ path: rel, reason: "total size limit" }); continue; }
      total += st.size;
      files.push({ path: rel, data: await fs.readFile(full) });
    }
  }
  await walk(dir);
  return { files, skipped };
}

export async function cloneToSnapshot(url: string, o: CloneOptions & { ref?: string } = {}): Promise<RepoSnapshot> {
  const ref: RepoRef = o.allowLocalPath ? { host: "other", owner: "local", repo: path.basename(url), cloneUrl: url, webUrl: url, slug: `local-${path.basename(url)}` } : parseRepoRef(url);
  if (o.ref) ref.ref = o.ref;
  const { dir, sha } = await cloneRepo(o.allowLocalPath ? url : ref.cloneUrl, { ...o, ref: o.ref ?? ref.ref });
  try {
    const { files, skipped } = await readDir(dir);
    // With core.symlinks=false git writes symlinks as plain files holding the target path. Ask git which
    // paths ARE symlinks (mode 120000) and drop them, so they are reported rather than mistaken for source.
    const ls = await run(["ls-files", "-s", "-z"], { cwd: dir, timeoutMs: 30_000, maxBuffer: 50_000_000 });
    const links = new Set(ls.stdout.split("\0").filter((l) => l.startsWith("120000")).map((l) => l.split("\t").slice(1).join("\t")));
    const real = files.filter((f) => !links.has(f.path));
    for (const l of links) skipped.push({ path: l, reason: "symlink (not followed)" });
    const snap = await snapshotFromFiles(ref, real, { method: "git", sha: sha ?? undefined });
    snap.skipped.push(...skipped);
    return snap;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* ---- working-tree operations (approved roots only; caller resolves `dir`) ---- */

export async function gitStatus(dir: string) {
  const isRepo = (await run(["rev-parse", "--is-inside-work-tree"], { cwd: dir, timeoutMs: 10_000 })).stdout.trim() === "true";
  if (!isRepo) return { isRepo: false as const };
  const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, timeoutMs: 10_000 })).stdout.trim();
  const st = (await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: dir, timeoutMs: 20_000 })).stdout;
  const changes = st.split("\0").filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3) }));
  return { isRepo: true as const, branch, changes };
}
export async function gitDiff(dir: string, file?: string) {
  const r = await run(["diff", "--no-color", "--no-ext-diff", "-U3", ...(file ? ["--", file] : [])], { cwd: dir, timeoutMs: 30_000, maxBuffer: 5_000_000 });
  return r.stdout;
}
export async function gitInit(dir: string) { return (await run(["init", "-b", "main"], { cwd: dir, timeoutMs: 10_000 })).code === 0; }
export async function gitCommitAll(dir: string, message: string, author = { name: "OmniForge RE", email: "omniforge@localhost" }) {
  await run(["add", "-A"], { cwd: dir, timeoutMs: 60_000 });
  const r = await run(["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "-c", "commit.gpgsign=false", "commit", "-m", message], { cwd: dir, timeoutMs: 60_000 });
  if (r.code !== 0 && /nothing to commit/.test(r.stdout + r.stderr)) return { ok: false as const, message: "Nothing to commit" };
  if (r.code !== 0) return { ok: false as const, message: (r.stderr || r.stdout).trim().slice(0, 300) };
  return { ok: true as const, sha: (await run(["rev-parse", "HEAD"], { cwd: dir, timeoutMs: 10_000 })).stdout.trim() };
}
export async function gitLog(dir: string, n = 20) {
  const r = await run(["log", `-n${n}`, "--pretty=format:%H%x1f%an%x1f%ad%x1f%s", "--date=iso-strict"], { cwd: dir, timeoutMs: 20_000 });
  return r.stdout.split("\n").filter(Boolean).map((l) => { const [sha, author, date, subject] = l.split("\x1f"); return { sha: sha!, author: author!, date: date!, subject: subject! }; });
}
export async function gitCheckout(dir: string, branch: string, create = false) {
  if (!/^[\w./-]{1,100}$/.test(branch) || branch.startsWith("-")) throw new UserError("Invalid branch name");
  const r = await run(["checkout", ...(create ? ["-b"] : []), branch], { cwd: dir, timeoutMs: 30_000 });
  return r.code === 0 ? { ok: true as const } : { ok: false as const, message: r.stderr.trim().slice(0, 300) };
}
void filterFiles;
