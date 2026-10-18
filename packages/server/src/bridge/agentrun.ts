/**
 * CLI-direct agent runs. The CLI never touches the user's folder: it edits an ISOLATED COPY (a "shadow") that has a git baseline commit,
 * the result is listed as a diff, and changes reach the real folder only through `applyChanges`, per file, after the user has reviewed them.
 *
 * What the copy leaves out, and why:
 *  - .git, node_modules, build output, virtualenvs … (size, and the agent should not edit them);
 *  - credential-style files (.env, keys) — the CLI is never shown secrets;
 *  - project-level agent configuration (.claude/, .mcp.json, CLAUDE.md, AGENTS.md …): in an analysed repository this is untrusted input to a
 *    different tool (hooks and MCP servers execute commands); the run also passes `--setting-sources user`.
 */
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeAgentArgs, mcpConfigJson, normalizeClaudeLine, type AgentEvent, type ClaudeAgentOptions } from "@omniforge/core";
import { SECRET_FILE } from "./fsx.js";
import { passEnvFor } from "./clis.js";
import { augmentedPath, sanitizedEnv } from "./jobs.js";

export const EXCLUDE_DIRS = new Set([".git", "node_modules", ".next", ".nuxt", ".svelte-kit", "dist", "build", "out", "target", ".venv", "venv", "__pycache__", ".turbo", ".cache", ".parcel-cache", "coverage", ".gradle", ".idea", ".vs", ".claude", ".cursor", ".codex", ".gemini", ".aider.tags.cache.v3"]);
export const EXCLUDE_FILES = /^(?:\.mcp\.json|CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|GEMINI\.md|\.DS_Store|\.aider\.chat\.history\.md|\.aider\.input\.history)$/i;
export const LIMITS = { files: 20_000, fileBytes: 2_000_000, totalBytes: 200_000_000 };

const git = (cwd: string, args: string[], input?: string) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
  const c = execFile("git", ["-c", "user.name=OmniForge RE", "-c", "user.email=omniforge@localhost", "-c", "core.autocrlf=false", "-c", "core.quotepath=off", "-c", "commit.gpgsign=false", ...args], { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PATH: augmentedPath(), GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => resolve({ code: err ? (typeof (err as { code?: number }).code === "number" ? (err as { code?: number }).code! : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  if (input !== undefined) c.stdin?.end(input);
});
const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

export interface Shadow { id: string; dir: string; work: string; rootPath: string; copied: number; bytes: number; skipped: { path: string; reason: string }[]; baseline: Map<string, string>; createdAt: number }

export async function createShadow(rootPath: string, o: { tmp?: string } = {}): Promise<Shadow> {
  const rootReal = await fsp.realpath(rootPath);
  const id = crypto.randomBytes(8).toString("hex");
  const dir = path.join(o.tmp ?? os.tmpdir(), `omniforge-agent-${id}`); const work = path.join(dir, "work");
  await fsp.mkdir(work, { recursive: true, mode: 0o700 });
  const s: Shadow = { id, dir, work, rootPath: rootReal, copied: 0, bytes: 0, skipped: [], baseline: new Map(), createdAt: Date.now() };
  const skip = (rel: string, reason: string) => { if (s.skipped.length < 500) s.skipped.push({ path: rel, reason }); };
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const e of await fsp.readdir(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name; const a = path.join(abs, e.name);
      if (e.isSymbolicLink()) { skip(r, "symbolic link"); continue; }
      if (e.isDirectory()) { if (EXCLUDE_DIRS.has(e.name)) { skip(r + "/", e.name === ".claude" || e.name.startsWith(".") && /cursor|codex|gemini/.test(e.name) ? "agent configuration from the project is not trusted" : "excluded folder"); continue; } await fsp.mkdir(path.join(work, r), { recursive: true }); await walk(a, r); continue; }
      if (!e.isFile()) continue;
      if (SECRET_FILE.test(r)) { skip(r, "credential-style file — never shown to the CLI"); continue; }
      if (EXCLUDE_FILES.test(e.name)) { skip(r, "project agent instructions/config are not trusted"); continue; }
      const st = await fsp.stat(a);
      if (st.size > LIMITS.fileBytes) { skip(r, `larger than ${LIMITS.fileBytes / 1e6} MB`); continue; }
      if (s.copied >= LIMITS.files || s.bytes + st.size > LIMITS.totalBytes) throw new Error(`This folder is too large to copy for an agent run (limit ${LIMITS.files} files / ${LIMITS.totalBytes / 1e6} MB after exclusions). Choose a smaller folder.`);
      const buf = await fsp.readFile(a);
      await fsp.writeFile(path.join(work, r), buf, { mode: st.mode & 0o777 });
      s.baseline.set(r, sha256(buf)); s.copied++; s.bytes += st.size;
    }
  };
  try {
    await walk(rootReal, "");
    const init = await git(work, ["init", "-q", "-b", "main"]);
    if (init.code !== 0) throw new Error(`git is required for agent runs: ${init.stderr.trim().slice(0, 200) || "git init failed"}`);
    await git(work, ["add", "-A", "-f"]);
    const c = await git(work, ["commit", "-q", "--allow-empty", "-m", "baseline"]);
    if (c.code !== 0) throw new Error(`could not create the baseline: ${c.stderr.trim().slice(0, 200)}`);
  } catch (e) { await fsp.rm(dir, { recursive: true, force: true }); throw e; }
  return s;
}

export interface Change { path: string; status: "added" | "modified" | "deleted"; additions: number; deletions: number; binary: boolean; refused?: string }

const underExcluded = (rel: string) => rel.split("/").slice(0, -1).some((seg) => EXCLUDE_DIRS.has(seg));

export async function listChanges(s: Shadow): Promise<Change[]> {
  await git(s.work, ["add", "-A", "-f"]);
  const ns = await git(s.work, ["diff", "--cached", "--name-status", "--no-renames", "-z", "HEAD"]);
  const nu = await git(s.work, ["diff", "--cached", "--numstat", "--no-renames", "-z", "HEAD"]);
  const counts = new Map<string, { a: number; d: number; bin: boolean }>();
  // numstat -z: "<add>\t<del>\t<path>\0"
  for (const rec of nu.stdout.split("\0").filter(Boolean)) { const m = rec.match(/^(\S+)\t(\S+)\t([\s\S]+)$/); if (m) counts.set(m[3]!, { a: m[1] === "-" ? 0 : Number(m[1]), d: m[2] === "-" ? 0 : Number(m[2]), bin: m[1] === "-" }); }
  const parts = ns.stdout.split("\0").filter(Boolean); const out: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i]!; const rel = parts[i + 1]!; const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
    const n = counts.get(rel) ?? { a: 0, d: 0, bin: false };
    const ch: Change = { path: rel, status, additions: n.a, deletions: n.d, binary: n.bin };
    let st: fs.Stats | null = null; try { st = await fsp.lstat(path.join(s.work, rel)); } catch { /* deleted */ }
    if (rel.startsWith("/") || rel.split("/").includes("..")) ch.refused = "unsafe path";
    else if (st?.isSymbolicLink()) ch.refused = "symbolic links are never applied";
    else if (SECRET_FILE.test(rel)) ch.refused = "credential-style files are never applied";
    else if (underExcluded(rel)) ch.refused = "inside a folder that is excluded from agent runs";
    else if (EXCLUDE_FILES.test(path.basename(rel)) || rel.split("/").some((x) => x === ".claude")) ch.refused = "agent configuration files are never applied";
    else if (st && st.size > LIMITS.fileBytes) ch.refused = "file is too large";
    out.push(ch);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readSides(s: Shadow, rel: string): Promise<{ base: string | null; next: string | null; binary: boolean }> {
  const safe = rel.split("/").every((x) => x && x !== "..") && !path.isAbsolute(rel); if (!safe) throw new Error("Unsafe path");
  const b = await git(s.work, ["show", `HEAD:${rel}`]);
  let next: Buffer | null = null; try { const abs = path.join(s.work, rel); if ((await fsp.lstat(abs)).isFile()) next = await fsp.readFile(abs); } catch { /* deleted */ }
  const binary = (next ?? Buffer.from(b.stdout)).subarray(0, 8000).includes(0);
  return { base: b.code === 0 ? (binary ? "" : b.stdout) : null, next: next ? (binary ? "" : next.toString("utf8")) : null, binary };
}

export interface ApplyResult { applied: string[]; conflicts: { path: string; reason: string }[]; refused: { path: string; reason: string }[] }

/** Copy reviewed changes into the real folder. Conflicts (the original changed since the copy was made) are reported, never overwritten. */
export async function applyChanges(s: Shadow, o: { paths: string[]; allowDeletes?: boolean }): Promise<ApplyResult> {
  const res: ApplyResult = { applied: [], conflicts: [], refused: [] };
  const changes = new Map((await listChanges(s)).map((c) => [c.path, c]));
  const rootReal = await fsp.realpath(s.rootPath);
  for (const rel of [...new Set(o.paths)]) {
    const ch = changes.get(rel);
    if (!ch) { res.refused.push({ path: rel, reason: "not a change in this run" }); continue; }
    if (ch.refused) { res.refused.push({ path: rel, reason: ch.refused }); continue; }
    if (ch.status === "deleted" && !o.allowDeletes) { res.refused.push({ path: rel, reason: "deletions were not enabled" }); continue; }
    const target = path.resolve(rootReal, rel);
    if (!target.startsWith(rootReal + path.sep)) { res.refused.push({ path: rel, reason: "outside the folder" }); continue; }
    // the nearest existing ancestor must really be inside the folder (a symlinked directory in the original must not redirect the write)
    let anc = path.dirname(target); while (!fs.existsSync(anc)) anc = path.dirname(anc);
    const ancReal = await fsp.realpath(anc); if (ancReal !== rootReal && !ancReal.startsWith(rootReal + path.sep)) { res.refused.push({ path: rel, reason: "a parent folder resolves outside the project" }); continue; }
    let current: Buffer | null = null; try { const st = await fsp.lstat(target); if (st.isSymbolicLink() || !st.isFile()) { res.refused.push({ path: rel, reason: "the target is not a regular file" }); continue; } current = await fsp.readFile(target); } catch { /* does not exist */ }
    const base = s.baseline.get(rel);
    if (ch.status === "added") {
      const nextBuf = await fsp.readFile(path.join(s.work, rel));
      if (current && sha256(current) !== sha256(nextBuf)) { res.conflicts.push({ path: rel, reason: "a different file with this name now exists" }); continue; }
    } else {
      if (!current) { res.conflicts.push({ path: rel, reason: "the file no longer exists in the project" }); continue; }
      if (base && sha256(current) !== base) { res.conflicts.push({ path: rel, reason: "the file changed in the project after the copy was made" }); continue; }
    }
    if (ch.status === "deleted") { await fsp.unlink(target); res.applied.push(rel); continue; }
    const src = path.join(s.work, rel); const mode = (await fsp.stat(src)).mode & 0o777;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.omniforge-${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fsp.copyFile(src, tmp); await fsp.chmod(tmp, mode); await fsp.rename(tmp, target);
    res.applied.push(rel);
  }
  return res;
}

export async function discardShadow(s: Shadow) { await fsp.rm(s.dir, { recursive: true, force: true }); }

/* ------------------------------ running the CLI ------------------------------ */

export interface AgentRunOptions extends ClaudeAgentOptions { cliPath: string; prompt: string; timeoutMs?: number; signal?: AbortSignal; /** tests / hosts that authenticate via environment */ env?: Record<string, string> }

function killGroup(pid: number | undefined) { if (!pid) return; try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ } setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }, 3000).unref(); }

export async function* runClaudeAgent(s: Shadow, o: AgentRunOptions): AsyncGenerator<AgentEvent> {
  // The MCP config lives beside the copy, never inside it, so it can neither be edited by the agent into the diff nor applied to the project.
  claudeAgentArgs({ ...o, mcpConfigPath: "unchecked" }); // validate everything before touching the disk or spawning anything
  const mcpPath = o.mcpServers?.length ? path.join(s.dir, `mcp-${crypto.randomBytes(6).toString("hex")}.json`) : undefined;
  if (mcpPath) await fsp.writeFile(mcpPath, mcpConfigJson(o.mcpServers!), { mode: 0o600 });
  const args = claudeAgentArgs({ ...o, mcpConfigPath: mcpPath });
  const child = spawn(o.cliPath, args, { cwd: s.work, env: sanitizedEnv({ ...passEnvFor("claude-code"), ...o.env }), detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.on("error", () => {}); child.stdin!.end(o.prompt);
  const timer = setTimeout(() => killGroup(child.pid), o.timeoutMs ?? 20 * 60_000);
  const onAbort = () => killGroup(child.pid); o.signal?.addEventListener("abort", onAbort, { once: true });
  let stderr = ""; child.stderr!.on("data", (d) => { stderr = (stderr + d.toString()).slice(-8000); });
  const queue: AgentEvent[] = []; let wake: (() => void) | null = null; let ended = false; let code: number | null = null; let buf = ""; let sawResult = false; let spawnError: string | null = null;
  const push = (e: AgentEvent) => { if (e.type === "result") sawResult = true; queue.push(e); wake?.(); };
  child.stdout!.on("data", (d) => { buf += d.toString("utf8"); let i: number; while ((i = buf.indexOf("\n")) >= 0) { for (const e of normalizeClaudeLine(buf.slice(0, i))) push(e); buf = buf.slice(i + 1); } });
  child.on("close", (c) => { for (const e of normalizeClaudeLine(buf)) push(e); buf = ""; code = c; ended = true; wake?.(); });
  child.on("error", (e) => { spawnError = e.message; ended = true; wake?.(); });
  try {
    while (!ended || queue.length) { if (queue.length) { yield queue.shift()!; continue; } await new Promise<void>((r) => { wake = r; }); }
  } finally { clearTimeout(timer); o.signal?.removeEventListener("abort", onAbort); if (!ended) killGroup(child.pid); if (mcpPath) await fsp.rm(mcpPath, { force: true }); }
  if (o.signal?.aborted) { yield { type: "error", message: "Cancelled." }; return; }
  if (spawnError) yield { type: "error", message: `Could not start the CLI: ${spawnError}` };
  else if (!sawResult) yield { type: "error", message: `The CLI exited (code ${code}) without a result${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300)}` : "."}` };
}

/* ------------------------------ registry ------------------------------ */

const TTL_MS = 24 * 3600_000;
export class AgentRuns {
  private runs = new Map<string, { shadow: Shadow; rootId: string }>();
  add(shadow: Shadow, rootId: string) { this.sweep(); this.runs.set(shadow.id, { shadow, rootId }); }
  get(id: string) { const r = this.runs.get(id); if (!r) throw new Error("Unknown or expired agent run."); return r; }
  async discard(id: string) { const r = this.runs.get(id); if (r) { this.runs.delete(id); await discardShadow(r.shadow); } }
  sweep() { for (const [id, r] of this.runs) if (Date.now() - r.shadow.createdAt > TTL_MS) void this.discard(id); }
  async closeAll() { await Promise.all([...this.runs.keys()].map((id) => this.discard(id))); }
}
