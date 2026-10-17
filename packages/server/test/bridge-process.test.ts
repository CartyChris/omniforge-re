import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collect } from "@omniforge/core";
import { JobManager, sanitizedEnv } from "../src/bridge/jobs";
import { ADAPTERS, CliProvider, probeCli, runCli, testCli } from "../src/bridge/clis";
import { cloneRepo, cloneToSnapshot, gitCheckout, gitCommitAll, gitDiff, gitInit, gitLog, gitStatus, gitVersion, readDir } from "../src/bridge/git";
import { detectTools, systemInfo, which } from "../src/bridge/detect";

let tmp: string;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout waiting"); await sleep(25); } }
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-proc-")); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("JobManager", () => {
  const mk = () => new JobManager({ dir: fs.mkdtempSync(path.join(tmp, "jobs-")) });
  it("runs a command, streams lines, records exit state, and persists a log", async () => {
    const jm = mk();
    const m = jm.start({ kind: "t", cmd: "node", args: ["-e", "console.log('hello');console.error('warn');process.exit(3)"] });
    await until(() => jm.get(m.id)!.meta.state !== "running");
    const j = jm.get(m.id)!;
    expect(j.meta).toMatchObject({ state: "failed", code: 3 });
    expect(j.lines.map((l) => `${l.stream}:${l.text}`)).toEqual(expect.arrayContaining(["stdout:hello", "stderr:warn"]));
    const replay: string[] = [];
    jm.subscribe(m.id, (l) => { if (!("end" in l)) replay.push(l.text); });
    expect(replay).toContain("hello");
  });
  it("redacts secrets from output and from the recorded command", async () => {
    const jm = mk();
    const tok = ["ghp", "a".repeat(36)].join("_");
    const m = jm.start({ kind: "t", cmd: "node", args: ["-e", `console.log("token ${tok}")`] });
    await until(() => jm.get(m.id)!.meta.state !== "running");
    expect(jm.get(m.id)!.lines.map((l) => l.text).join("\n")).not.toContain(tok);
    expect(jm.get(m.id)!.meta.command).not.toContain(tok);
  });
  it("cancel kills the whole PROCESS GROUP (grandchildren too)", async () => {
    const jm = mk();
    const pidFile = path.join(tmp, "grandchild.pid");
    const m = jm.start({ kind: "t", shell: true, cmd: `sleep 60 & echo $! > ${pidFile}; wait` });
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().length > 0);
    const gpid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(alive(gpid)).toBe(true);
    expect(jm.cancel(m.id)).toBe(true);
    await until(() => jm.get(m.id)!.meta.state === "cancelled" && !alive(gpid), 8000);
    expect(alive(gpid)).toBe(false);
  });
  it("times out long jobs", async () => {
    const jm = mk();
    const m = jm.start({ kind: "t", cmd: "node", args: ["-e", "setTimeout(()=>{},60000)"], timeoutMs: 300 });
    await until(() => jm.get(m.id)!.meta.state === "timeout");
    expect(jm.get(m.id)!.lines.some((l) => /Timed out/.test(l.text))).toBe(true);
  });
  it("enforces a concurrency limit", async () => {
    const jm = new JobManager({ dir: fs.mkdtempSync(path.join(tmp, "jobs-")), maxConcurrent: 2 });
    const a = jm.start({ kind: "t", cmd: "node", args: ["-e", "setTimeout(()=>{},5000)"] }), b = jm.start({ kind: "t", cmd: "node", args: ["-e", "setTimeout(()=>{},5000)"] });
    expect(() => jm.start({ kind: "t", cmd: "node", args: ["-e", "1"] })).toThrow(/Too many running jobs/);
    jm.cancel(a.id); jm.cancel(b.id);
    await jm.shutdown();
  });
  it("marks jobs that were running when the bridge died as 'interrupted' on restart", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "jobs-"));
    fs.writeFileSync(path.join(dir, "deadbeef.json"), JSON.stringify({ id: "deadbeef", kind: "t", label: "x", command: "x", state: "running", startedAt: 1, lines: 0 }));
    const jm = new JobManager({ dir });
    expect(jm.get("deadbeef")!.meta.state).toBe("interrupted");
    expect(jm.list().map((j) => j.state)).toContain("interrupted");
  });
  it("does not leak the bridge's own secrets into child environments", async () => {
    process.env.OMNIFORGE_TEST_SECRET = "s3cr3t-value"; process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
    const env = sanitizedEnv();
    expect(env.OMNIFORGE_TEST_SECRET).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH).toBeTruthy();
    const jm = mk();
    const m = jm.start({ kind: "t", cmd: "node", args: ["-e", "console.log(JSON.stringify({a:process.env.OMNIFORGE_TEST_SECRET,b:process.env.AWS_SECRET_ACCESS_KEY}))"] });
    await until(() => jm.get(m.id)!.meta.state !== "running");
    expect(jm.get(m.id)!.lines.find((l) => l.stream === "stdout")!.text).toBe("{}");
    delete process.env.OMNIFORGE_TEST_SECRET; delete process.env.AWS_SECRET_ACCESS_KEY;
  });
  it("reports spawn failures instead of throwing", async () => {
    const jm = mk();
    const m = jm.start({ kind: "t", cmd: "definitely-not-a-command-xyz" });
    await until(() => jm.get(m.id)!.meta.state !== "running");
    expect(jm.get(m.id)!.meta.state).toBe("failed");
  });
});

describe("git", () => {
  it("is available and clones a local repo with hardening (tests-only local path opt-in)", async () => {
    expect(await gitVersion()).toMatch(/\d+\.\d+/);
    const src = fs.mkdtempSync(path.join(tmp, "src-"));
    execSync("git init -q -b main && git config user.email a@b.c && git config user.name t && echo hi > a.txt && mkdir sub && echo x > sub/b.js && git add -A && git commit -q -m init", { cwd: src });
    fs.symlinkSync("/etc/passwd", path.join(src, "evil-link"));
    execSync("git add -A && git commit -q -m link", { cwd: src });
    const snap = await cloneToSnapshot(src, { allowLocalPath: true });
    expect(snap.files.map((f) => f.path).sort()).toEqual(["a.txt", "sub/b.js"]); // symlink dropped, .git excluded
    expect(snap.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.method).toBe("git");
  });
  it("refuses non-https, private and credentialed URLs before running git", async () => {
    for (const u of ["file:///etc", "ssh://git@github.com/a/b", "http://localhost/a.git", "https://user:pw@github.com/a/b.git", "https://169.254.169.254/x.git", "git://github.com/a/b"]) await expect(cloneRepo(u), u).rejects.toThrow();
  });
  it("status / diff / commit / log / branch on a working tree", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "wt-"));
    expect(await gitInit(dir)).toBe(true);
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    expect(await gitStatus(dir)).toMatchObject({ isRepo: true, changes: [{ status: "??", path: "a.txt" }] });
    const c = await gitCommitAll(dir, "first");
    expect(c.ok).toBe(true);
    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    expect(await gitDiff(dir)).toMatch(/\+two/);
    expect((await gitCommitAll(dir, "second")).ok).toBe(true);
    expect((await gitCommitAll(dir, "nothing")).ok).toBe(false);
    expect((await gitLog(dir)).map((l) => l.subject)).toEqual(["second", "first"]);
    expect(await gitCheckout(dir, "feature", true)).toEqual({ ok: true });
    await expect(gitCheckout(dir, "--evil")).rejects.toThrow(/Invalid branch/);
    expect(await gitStatus(os.tmpdir())).toMatchObject({ isRepo: false });
  });
  it("REAL clone of a public GitHub repo over the network (skipped if offline)", async () => {
    const reach = await fetch("https://github.com", { method: "HEAD" }).then(() => true, () => false);
    // git uses the session proxy even when raw fetch cannot; probe with git itself
    let ok = false;
    try { execSync("git ls-remote https://github.com/octocat/Hello-World HEAD", { timeout: 20000, stdio: "pipe" }); ok = true; } catch { ok = false; }
    if (!ok && !reach) return;
    const snap = await cloneToSnapshot("https://github.com/octocat/Hello-World", { timeoutMs: 90_000 });
    expect(snap.files.some((f) => f.path === "README")).toBe(true);
    expect(snap.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.ref).toMatchObject({ owner: "octocat", repo: "Hello-World" });
  }, 120_000);
  it("readDir skips symlinks and .git", async () => {
    const d = fs.mkdtempSync(path.join(tmp, "rd-"));
    fs.mkdirSync(path.join(d, ".git")); fs.writeFileSync(path.join(d, ".git/HEAD"), "x"); fs.writeFileSync(path.join(d, "a"), "1"); fs.symlinkSync("/etc/hosts", path.join(d, "l"));
    const r = await readDir(d);
    expect(r.files.map((f) => f.path)).toEqual(["a"]);
    expect(r.skipped.map((s) => s.path)).toEqual(["l"]);
  });
});

describe("detection", () => {
  it("reports the host and tool states truthfully", async () => {
    const sys = await systemInfo();
    expect(sys).toMatchObject({ platform: process.platform, arch: process.arch });
    expect(sys.memTotalGB).toBeGreaterThan(0);
    const tools = await detectTools();
    const by = Object.fromEntries(tools.map((t) => [t.id, t]));
    expect(by.node).toMatchObject({ status: "available", version: expect.stringMatching(/^\d+\.\d+/) });
    expect(by.git!.path).toBe(which("git"));
    if (process.platform !== "darwin") for (const id of ["xcodebuild", "lipo", "otool", "codesign", "plutil", "hopper"]) expect(by[id]!.status, id).toBe("unsupported-platform");
    expect(by["definitely-missing"]).toBeUndefined();
    expect(by["ast-grep"]!.status).not.toBe("needs-configuration"); // Linux `sg` (newgrp) must not be mistaken for ast-grep
  });
});

describe("AI CLI adapters (driven through fake CLIs on PATH)", () => {
  let bin: string; let oldPath: string | undefined;
  const script = (name: string, body: string) => { const p = path.join(bin, name); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  beforeAll(() => {
    bin = fs.mkdtempSync(path.join(tmp, "bin-")); oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
    // a Claude-like CLI that supports stream-json
    script("claude", `case "$1" in
 --version) echo "2.0.0 (Claude Code)";;
 --help) echo "  -p, --print   Print response"; echo "  --output-format <format>"; echo "  --verbose";;
 auth) echo "Logged in as test@example.com";;
 *) PROMPT=$(cat); echo '{"type":"system","subtype":"init"}'; echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Echo: '"$(echo "$PROMPT" | head -c 20)"'"}]}}'; echo '{"type":"result","result":"done","usage":{"input_tokens":5,"output_tokens":3}}';;
esac`);
    // a codex-like CLI whose --help lacks any non-interactive mode
    script("codex", `case "$1" in --version) echo "codex 0.1.0";; *) echo "Interactive TUI only";; esac`);
    // gemini-like: supports --prompt only (text)
    script("gemini", `case "$1" in --version) echo "0.5.1";; --help) echo "  --prompt, -p  Prompt";; --prompt) shift; echo "gemini says: $1";; esac`);
    // a CLI that hangs, to test cancellation
    script("opencode", `case "$1" in --version) echo "1.0.0";; --help) echo "  run  Run a prompt";; run) sleep 60 & echo $! > ${path.join(tmp, "oc.pid")}; wait;; esac`);
  });
  afterAll(() => { process.env.PATH = oldPath; });

  it("chooses the invocation method by probing --help, and reports unsupported ones honestly", async () => {
    const claude = await probeCli(ADAPTERS.find((a) => a.id === "claude-code")!);
    expect(claude).toMatchObject({ status: "ready", method: "print-stream-json", version: "2.0.0", authenticated: true });
    expect(claude.methods.map((m) => [m.id, m.supported])).toEqual([["print-stream-json", true], ["print-text", true]]);
    const codex = await probeCli(ADAPTERS.find((a) => a.id === "codex")!);
    expect(codex.status).toBe("unsupported-invocation"); // never driven blindly
    expect(codex.methods.every((m) => !m.supported && m.missing.length > 0)).toBe(true);
    const gemini = await probeCli(ADAPTERS.find((a) => a.id === "gemini")!);
    expect(gemini).toMatchObject({ status: "ready", method: "prompt" }); // falls back to the supported method
    expect(gemini.methods.find((m) => m.id === "prompt-json")).toMatchObject({ supported: false, missing: ["--output-format"] });
    expect((await probeCli(ADAPTERS.find((a) => a.id === "aider")!)).status).toBe("not-installed");
  });
  it("streams Claude stream-json events, sends the prompt over stdin, and reports usage", async () => {
    const a = ADAPTERS.find((x) => x.id === "claude-code")!;
    const r = await collect(runCli(a, await probeCli(a), { prompt: "Hello there, world" }));
    expect(r.text).toContain("Echo: Hello there, world".slice(0, 20));
    expect(r.usage).toEqual({ input: 5, output: 3 });
    expect(r.finish).toBe("stop");
  });
  it("runs a text-mode CLI and exposes any CLI as a Provider for the router/agents", async () => {
    const a = ADAPTERS.find((x) => x.id === "gemini")!;
    const info = await probeCli(a);
    expect((await collect(runCli(a, info, { prompt: "hi" }))).text).toContain("gemini says: hi");
    const p = new CliProvider(a, info);
    expect((await p.listModels())[0]).toMatchObject({ id: "gemini", local: false, capabilities: expect.arrayContaining(["chat", "code"]) });
    const r = await collect(p.chat({ model: "gemini", system: "be brief", messages: [{ role: "user", content: "ping" }] }));
    expect(r.text).toMatch(/gemini says:/);
    expect(await p.health()).toMatchObject({ ok: true });
  });
  it("refuses to run an unsupported CLI", async () => {
    const a = ADAPTERS.find((x) => x.id === "codex")!;
    await expect(collect(runCli(a, await probeCli(a), { prompt: "x" }))).rejects.toThrow(/not available for non-interactive use/);
  });
  it("the connectivity test verifies the reply, not just exit status", async () => {
    const a = ADAPTERS.find((x) => x.id === "claude-code")!;
    const v = await testCli(a, await probeCli(a), 10_000);
    expect(v.ok).toBe(false); // the fake CLI echoes the prompt instead of replying PONG → must NOT count as working
  });
  it("cancellation (AbortSignal) kills the CLI's process group", async () => {
    const a = ADAPTERS.find((x) => x.id === "opencode")!;
    const info = await probeCli(a);
    const ctrl = new AbortController();
    const p = collect(runCli(a, info, { prompt: "x", signal: ctrl.signal })).catch((e) => e);
    await until(() => fs.existsSync(path.join(tmp, "oc.pid")) && fs.readFileSync(path.join(tmp, "oc.pid"), "utf8").trim() !== "");
    const gpid = Number(fs.readFileSync(path.join(tmp, "oc.pid"), "utf8").trim());
    expect(alive(gpid)).toBe(true);
    ctrl.abort();
    const err = await p;
    expect((err as Error).name).toBe("AbortError");
    await until(() => !alive(gpid), 8000);
  }, 20_000);
});

describe("the REAL Claude Code CLI (skipped when not installed)", () => {
  it("is detected with its genuine flags and answers a benign prompt", async () => {
    const real = which("claude", );
    // use the original PATH: fake CLIs from the previous suite are removed in afterAll
    if (!real || real.startsWith(os.tmpdir())) return;
    const a = ADAPTERS.find((x) => x.id === "claude-code")!;
    const info = await probeCli(a);
    expect(["ready", "installed-unauthenticated"]).toContain(info.status);
    expect(info.method).toBe("print-stream-json");
    if (info.status === "ready") {
      const v = await testCli(a, info, 120_000);
      expect(v.ok, JSON.stringify(v)).toBe(true);
    }
  }, 150_000);
});
