/**
 * Authorised child-process management: argv execution (no shell unless the
 * caller explicitly asks and is authorised), sanitised environment, process
 * group kill on cancel/timeout, bounded output, secret redaction, persistence
 * and crash recovery (jobs that were running when the bridge died are marked
 * "interrupted" on the next start rather than silently disappearing).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { redactSecrets } from "@omniforge/core";
import { UserError } from "../http.js";

export type JobState = "running" | "done" | "failed" | "cancelled" | "timeout" | "interrupted";
export interface JobLine { seq: number; stream: "stdout" | "stderr" | "system"; text: string; t: number }
export interface JobMeta { id: string; kind: string; label: string; command: string; cwd?: string; state: JobState; code?: number | null; startedAt: number; endedAt?: number; lines: number; progress?: { phase: string; completed: number; total: number; message: string } }

const EXTRA_PATHS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin", path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), ".cargo/bin"), path.join(os.homedir(), ".bun/bin"), path.join(os.homedir(), ".npm-global/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
export const augmentedPath = () => [...new Set([...(process.env.PATH ?? "").split(path.delimiter), ...EXTRA_PATHS])].filter(Boolean).join(path.delimiter);

/** Environment passed to children: an allow-list, never the bridge's own secrets. */
export function sanitizedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ["HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "SSH_AUTH_SOCK", "PLAYWRIGHT_BROWSERS_PATH", "JAVA_HOME", "GHIDRA_INSTALL_DIR", "CARGO_HOME", "RUSTUP_HOME", "NVM_DIR", "PYENV_ROOT", "DEVELOPER_DIR"];
  const env: NodeJS.ProcessEnv = { PATH: augmentedPath(), CI: "1", NO_COLOR: "1" };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

export interface StartOptions { /** write stdout to this file instead of the line log (large JSON results) */ stdoutFile?: string; kind: string; label?: string; cmd: string; args?: string[]; shell?: boolean; cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number; onLine?: (l: JobLine) => void; progressParser?: (line: string) => JobMeta["progress"] | undefined }

export class JobManager {
  private jobs = new Map<string, { meta: JobMeta; lines: JobLine[]; child?: ChildProcess; subs: Set<(l: JobLine | { end: JobMeta }) => void>; bytes: number }>();
  private dir: string;
  constructor(o: { dir?: string; maxConcurrent?: number } = {}) {
    this.dir = o.dir ?? path.join(os.homedir(), ".omniforge", "jobs");
    this.max = o.maxConcurrent ?? 4;
    fs.mkdirSync(this.dir, { recursive: true });
    this.recover();
  }
  private max: number;

  private recover() {
    for (const f of fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      try {
        const meta: JobMeta = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
        if (meta.state === "running") { meta.state = "interrupted"; meta.endedAt = Date.now(); fs.writeFileSync(path.join(this.dir, f), JSON.stringify(meta)); }
        let lines: JobLine[] = [];
        try { lines = fs.readFileSync(path.join(this.dir, f.replace(/\.json$/, ".log")), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* no log */ }
        this.jobs.set(meta.id, { meta, lines, subs: new Set(), bytes: 0 });
      } catch { /* ignore corrupt */ }
    }
  }
  private persist(id: string) { const j = this.jobs.get(id); if (j) try { fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(j.meta)); } catch { /* best effort */ } }

  running() { return [...this.jobs.values()].filter((j) => j.meta.state === "running").length; }
  list(): JobMeta[] { return [...this.jobs.values()].map((j) => j.meta).sort((a, b) => b.startedAt - a.startedAt); }
  get(id: string) { return this.jobs.get(id); }

  start(o: StartOptions): JobMeta {
    if (this.running() >= this.max) throw new UserError(`Too many running jobs (limit ${this.max}). Wait for one to finish or cancel it.`);
    const id = randomBytes(6).toString("hex");
    const command = o.shell ? o.cmd : [o.cmd, ...(o.args ?? [])].join(" ");
    const meta: JobMeta = { id, kind: o.kind, label: o.label ?? command.slice(0, 80), command: redactSecrets(command).text, cwd: o.cwd, state: "running", startedAt: Date.now(), lines: 0 };
    const job = { meta, lines: [] as JobLine[], child: undefined as ChildProcess | undefined, subs: new Set<(l: JobLine | { end: JobMeta }) => void>(), bytes: 0 };
    this.jobs.set(id, job);
    const logPath = path.join(this.dir, `${id}.log`);
    const push = (stream: JobLine["stream"], text: string) => {
      const red = redactSecrets(text).text;
      if (job.bytes > (o.maxOutputBytes ?? 8_000_000)) return;
      job.bytes += red.length;
      const line: JobLine = { seq: job.meta.lines++, stream, text: red, t: Date.now() };
      job.lines.push(line);
      try { fs.appendFileSync(logPath, JSON.stringify(line) + "\n"); } catch { /* ignore */ }
      if (stream === "stderr" && o.progressParser) { const p = o.progressParser(text); if (p) job.meta.progress = p; }
      o.onLine?.(line);
      for (const s of job.subs) s(line);
    };
    let child: ChildProcess;
    try {
      child = o.shell
        ? spawn("/bin/sh", ["-c", o.cmd], { cwd: o.cwd, env: sanitizedEnv(o.env), detached: true, stdio: ["ignore", "pipe", "pipe"] })
        : spawn(o.cmd, o.args ?? [], { cwd: o.cwd, env: sanitizedEnv(o.env), detached: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (e) {
      job.meta.state = "failed"; job.meta.endedAt = Date.now(); push("system", `Failed to start: ${(e as Error).message}`); this.persist(id); return job.meta;
    }
    job.child = child;
    push("system", `$ ${meta.command}`);
    const feed = (stream: "stdout" | "stderr") => { let buf = ""; return (d: Buffer) => { buf += d.toString("utf8"); let i; while ((i = buf.indexOf("\n")) >= 0) { push(stream, buf.slice(0, i)); buf = buf.slice(i + 1); } if (buf.length > 64_000) { push(stream, buf); buf = ""; } }; };
    if (o.stdoutFile) {
      const out = fs.createWriteStream(o.stdoutFile, { mode: 0o600 });
      let n = 0;
      child.stdout!.on("data", (d: Buffer) => { n += d.length; });
      child.stdout!.pipe(out);
      child.on("close", () => push("system", `stdout saved (${n} bytes)`));
    } else child.stdout!.on("data", feed("stdout"));
    child.stderr!.on("data", feed("stderr"));
    const timer = o.timeoutMs ? setTimeout(() => { if (job.meta.state === "running") { job.meta.state = "timeout"; push("system", `Timed out after ${Math.round(o.timeoutMs! / 1000)} s; terminating`); this.kill(id); } }, o.timeoutMs) : undefined;
    const end = (code: number | null, err?: Error) => {
      if (timer) clearTimeout(timer);
      if (err) push("system", `Process error: ${err.message}`);
      if (job.meta.state === "running") job.meta.state = code === 0 ? "done" : "failed";
      job.meta.code = code; job.meta.endedAt = Date.now();
      this.persist(id);
      for (const s of job.subs) s({ end: job.meta });
    };
    child.on("error", (e) => end(null, e));
    child.on("close", (code) => end(code));
    this.persist(id);
    return job.meta;
  }

  /** Kill the whole process group, escalating to SIGKILL. */
  kill(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j?.child || j.child.exitCode !== null || !j.child.pid) return false;
    const pid = j.child.pid;
    try { process.kill(-pid, "SIGTERM"); } catch { try { j.child.kill("SIGTERM"); } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }, 3000).unref();
    return true;
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.meta.state !== "running") return false;
    j.meta.state = "cancelled";
    return this.kill(id);
  }

  /** Replay history then stream live lines. Returns an unsubscribe function. */
  subscribe(id: string, cb: (l: JobLine | { end: JobMeta }) => void, fromSeq = 0): () => void {
    const j = this.jobs.get(id);
    if (!j) { cb({ end: { id, kind: "", label: "", command: "", state: "failed", startedAt: 0, lines: 0 } }); return () => {}; }
    for (const l of j.lines) if (l.seq >= fromSeq) cb(l);
    if (j.meta.state !== "running") { cb({ end: j.meta }); return () => {}; }
    j.subs.add(cb);
    return () => j.subs.delete(cb);
  }

  /** Cancel everything (clean shutdown). */
  async shutdown() { for (const j of this.jobs.values()) if (j.meta.state === "running") this.cancel(j.meta.id); await new Promise((r) => setTimeout(r, 200)); }
}
