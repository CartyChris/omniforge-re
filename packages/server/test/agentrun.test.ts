import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyChanges, createShadow, discardShadow, listChanges, readSides, runClaudeAgent, type Shadow } from "../src/bridge/agentrun";
import { detectClis } from "../src/bridge/clis";

const FAKE = path.join(__dirname, "fixtures/fake-claude.mjs");
let tmp: string; let proj: string;
const mk = (rel: string, content: string | Buffer) => { const p = path.join(proj, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-agent-test-")); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  proj = fs.mkdtempSync(path.join(tmp, "proj-"));
  mk("src/app.js", "console.log(1);\n"); mk("old.txt", "old\n"); mk("README.md", "# hi\n"); mk("tool.sh", "#!/bin/sh\necho hi\n"); fs.chmodSync(path.join(proj, "tool.sh"), 0o755);
  mk(".env", "SECRET=hunter2\n"); mk(".claude/settings.json", '{"hooks":{"PreToolUse":[]}}'); mk("CLAUDE.md", "project rules"); mk("node_modules/dep/index.js", "x"); mk(".git/HEAD", "ref"); mk("big.dat", Buffer.alloc(2_100_000, 1));
  fs.symlinkSync("/etc/hosts", path.join(proj, "hosts-link"));
});

const run = async (s: Shadow, mode: string, extra: Record<string, unknown> = {}) => { const ev = []; for await (const e of runClaudeAgent(s, { cliPath: FAKE, prompt: "Please change things", env: { FAKE_MODE: mode }, ...extra })) ev.push(e); return ev; };

describe("MCP servers", () => {
  it("passes the approved list through a private config file that lives outside the copy and is gone afterwards", async () => {
    const s = await createShadow(proj, { tmp });
    try {
      const servers = [{ name: "docs", command: "npx", args: ["-y", "some-mcp@1.2.3"] }, { name: "remote", url: "https://mcp.example.com/mcp" }];
      const ev = await run(s, "mcp", { mcpServers: servers });
      expect(ev.at(-1)).toMatchObject({ type: "result", ok: true });
      const seen = JSON.parse(fs.readFileSync(path.join(s.work, "mcp-seen.json"), "utf8"));
      expect(seen.cfg).toEqual({ mcpServers: { docs: { command: "npx", args: ["-y", "some-mcp@1.2.3"] }, remote: { type: "http", url: "https://mcp.example.com/mcp" } } });
      expect(seen.cfgMode).toBe(0o600);
      expect(seen.cfgPath.startsWith(s.dir + path.sep)).toBe(true); expect(seen.cfgPath.startsWith(s.work + path.sep)).toBe(false);
      expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1]).toBe("Read,Edit,Write,Glob,Grep,mcp__docs,mcp__remote");
      expect(seen.argv).toContain("--strict-mcp-config");
      expect(fs.existsSync(seen.cfgPath)).toBe(false); // removed when the run ends
      expect((await listChanges(s)).map((c) => c.path)).toEqual(["mcp-seen.json"]); // the config itself can never reach the diff
    } finally { await discardShadow(s); }
  });
  it("without servers there is no config file and no --mcp-config", async () => {
    const s = await createShadow(proj, { tmp });
    try { await run(s, "mcp"); const seen = JSON.parse(fs.readFileSync(path.join(s.work, "mcp-seen.json"), "utf8")); expect(seen.cfgPath).toBeNull(); expect(seen.argv).not.toContain("--mcp-config"); } finally { await discardShadow(s); }
  });
  it("an invalid server stops the run before anything is spawned", async () => {
    const s = await createShadow(proj, { tmp });
    try { await expect(run(s, "mcp", { mcpServers: [{ name: "x", command: "bash", args: ["-c", "id"] }] })).rejects.toThrow(/cannot be used to launch/); expect(fs.existsSync(path.join(s.work, "mcp-seen.json"))).toBe(false); } finally { await discardShadow(s); }
  });
});

describe("createShadow", () => {
  it("copies the project but never credentials, project agent config, dependencies, .git, symlinks or huge files", async () => {
    const s = await createShadow(proj, { tmp });
    try {
      const files = fs.readdirSync(s.work, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(s.work, f)).isFile() && !f.startsWith(".git/")).sort();
      expect(files).toEqual(["README.md", "old.txt", "src/app.js", "tool.sh"]);
      const why = Object.fromEntries(s.skipped.map((k) => [k.path, k.reason]));
      expect(why[".env"]).toMatch(/credential/); expect(why[".claude/"]).toMatch(/not trusted/); expect(why["CLAUDE.md"]).toMatch(/not trusted/);
      expect(why["node_modules/"]).toMatch(/excluded/); expect(why[".git/"]).toMatch(/excluded/); expect(why["hosts-link"]).toMatch(/symbolic/); expect(why["big.dat"]).toMatch(/larger than/);
      expect(fs.statSync(path.join(s.work, "tool.sh")).mode & 0o111).not.toBe(0); // executable bit preserved
      expect(s.baseline.size).toBe(4);
      expect(await listChanges(s)).toEqual([]); // nothing changed yet
    } finally { await discardShadow(s); }
  });
  it("refuses a folder over the size limits instead of copying part of it", async () => {
    const s = createShadow(proj, { tmp }); await expect(s).resolves.toBeTruthy(); await discardShadow(await s);
  });
});

describe("a scripted agent run", () => {
  it("emits normalised events, edits only the copy, and the diff lists added / modified / deleted / binary files", async () => {
    const s = await createShadow(proj, { tmp });
    try {
      const ev = await run(s, "edit");
      expect(ev.map((e) => e.type)).toEqual(["init", "tool", "tool", "text", "result"]);
      expect(ev[0]).toMatchObject({ type: "init", model: "fake-model" });
      expect(ev.at(-1)).toMatchObject({ type: "result", ok: true, costUsd: 0.01 });
      expect(fs.readFileSync(path.join(proj, "src/app.js"), "utf8")).toBe("console.log(1);\n"); // the real folder is untouched
      const ch = await listChanges(s);
      expect(ch.map((c) => `${c.status}:${c.path}`)).toEqual(["added:logo.bin", "deleted:old.txt", "modified:src/app.js", "added:src/new.js"]); // sorted by path
      expect(ch.find((c) => c.path === "src/app.js")).toMatchObject({ additions: 1, deletions: 0, binary: false });
      expect(ch.find((c) => c.path === "logo.bin")).toMatchObject({ binary: true });
      const sides = await readSides(s, "src/app.js"); expect(sides.base).toBe("console.log(1);\n"); expect(sides.next).toContain("edited by agent");
      expect((await readSides(s, "old.txt")).next).toBeNull(); expect((await readSides(s, "src/new.js")).base).toBeNull();
      await expect(readSides(s, "../etc/passwd")).rejects.toThrow(/Unsafe/);
    } finally { await discardShadow(s); }
  }, 30_000);

  it("hostile output is listed as refused and can never be applied: credentials, agent config, dependencies, symlinks", async () => {
    const s = await createShadow(proj, { tmp });
    try {
      await run(s, "hostile");
      const ch = await listChanges(s); const by = Object.fromEntries(ch.map((c) => [c.path, c.refused ?? null]));
      expect(by[".env"]).toMatch(/credential/); expect(by[".claude/settings.json"]).toMatch(/agent configuration|excluded/); expect(by["node_modules/x/index.js"]).toMatch(/excluded/);
      expect(by["CLAUDE.md"]).toMatch(/agent configuration/); expect(by["link-to-passwd"]).toMatch(/symbolic/); expect(by["ok.txt"]).toBeNull();
      const r = await applyChanges(s, { paths: ch.map((c) => c.path) });
      expect(r.applied).toEqual(["ok.txt"]); expect(r.refused.map((x) => x.path).sort()).toEqual([".claude/settings.json", ".env", "CLAUDE.md", "link-to-passwd", "node_modules/x/index.js"]);
      expect(fs.readFileSync(path.join(proj, ".env"), "utf8")).toBe("SECRET=hunter2\n"); expect(fs.existsSync(path.join(proj, "link-to-passwd"))).toBe(false);
    } finally { await discardShadow(s); }
  }, 30_000);

  it("reports a CLI that crashes or never answers, and kills a CLI that is cancelled", async () => {
    const s = await createShadow(proj, { tmp });
    try {
      const crash = await run(s, "crash"); expect(crash.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("boom: something went wrong") });
      const ctl = new AbortController(); setTimeout(() => ctl.abort(), 400); const t0 = Date.now();
      const sleepy = await run(s, "sleep", { signal: ctl.signal }); expect(sleepy.at(-1)).toMatchObject({ type: "error", message: "Cancelled." }); expect(Date.now() - t0).toBeLessThan(15_000);
      const bad = []; for await (const e of runClaudeAgent(s, { cliPath: "/nonexistent/claude", prompt: "x" })) bad.push(e); expect(bad.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/Could not start/) });
      expect(await listChanges(s)).toEqual([]);
    } finally { await discardShadow(s); }
  }, 40_000);
});

describe("applyChanges", () => {
  it("applies only the selected files, preserving permissions, and leaves no temp files", async () => {
    const s = await createShadow(proj, { tmp });
    try {
      await run(s, "edit");
      const r = await applyChanges(s, { paths: ["src/app.js", "src/new.js"] });
      expect(r.applied.sort()).toEqual(["src/app.js", "src/new.js"]); expect(r.conflicts).toEqual([]);
      expect(fs.readFileSync(path.join(proj, "src/app.js"), "utf8")).toContain("edited by agent"); expect(fs.existsSync(path.join(proj, "src/new.js"))).toBe(true);
      expect(fs.existsSync(path.join(proj, "old.txt"))).toBe(true); expect(fs.existsSync(path.join(proj, "logo.bin"))).toBe(false); // not selected
      expect(fs.readdirSync(path.join(proj, "src")).some((f) => f.endsWith(".tmp"))).toBe(false);
    } finally { await discardShadow(s); }
  }, 30_000);
  it("never deletes unless deletions are explicitly enabled", async () => {
    const s = await createShadow(proj, { tmp });
    try {
      await run(s, "edit");
      expect((await applyChanges(s, { paths: ["old.txt"] })).refused).toEqual([{ path: "old.txt", reason: "deletions were not enabled" }]); expect(fs.existsSync(path.join(proj, "old.txt"))).toBe(true);
      expect((await applyChanges(s, { paths: ["old.txt"], allowDeletes: true })).applied).toEqual(["old.txt"]); expect(fs.existsSync(path.join(proj, "old.txt"))).toBe(false);
    } finally { await discardShadow(s); }
  }, 30_000);
  it("does not overwrite work done in the project after the copy was made (conflicts are reported)", async () => {
    const s = await createShadow(proj, { tmp });
    try {
      await run(s, "edit");
      fs.writeFileSync(path.join(proj, "src/app.js"), "console.log('my own change');\n"); mk("src/new.js", "something else\n"); fs.unlinkSync(path.join(proj, "old.txt"));
      const r = await applyChanges(s, { paths: ["src/app.js", "src/new.js", "old.txt"], allowDeletes: true });
      expect(r.applied).toEqual([]); expect(r.conflicts.map((c) => c.path).sort()).toEqual(["old.txt", "src/app.js", "src/new.js"]);
      expect(fs.readFileSync(path.join(proj, "src/app.js"), "utf8")).toContain("my own change");
    } finally { await discardShadow(s); }
  }, 30_000);
  it("refuses paths that are not changes of this run (traversal, absolute, unknown) and parents that resolve outside the project", async () => {
    const s = await createShadow(proj, { tmp });
    try {
      await run(s, "edit");
      const r = await applyChanges(s, { paths: ["../escape.txt", "/etc/passwd", "does/not/exist.txt", "src/../../x"] });
      expect(r.applied).toEqual([]); expect(r.refused).toHaveLength(4);
      // an original that turned `src/` into a symlink to somewhere else must not redirect the write
      const outside = fs.mkdtempSync(path.join(tmp, "outside-")); fs.rmSync(path.join(proj, "src"), { recursive: true, force: true }); fs.symlinkSync(outside, path.join(proj, "src"));
      const r2 = await applyChanges(s, { paths: ["src/new.js"] });
      expect(r2.applied).toEqual([]); expect(fs.readdirSync(outside)).toEqual([]);
      expect([...r2.refused, ...r2.conflicts].length).toBe(1);
    } finally { await discardShadow(s); }
  }, 30_000);
  it("an empty run changes nothing", async () => {
    const s = await createShadow(proj, { tmp });
    try { const ev = await run(s, "noop"); expect(ev.at(-1)).toMatchObject({ type: "result", ok: true }); expect(await listChanges(s)).toEqual([]); expect(await applyChanges(s, { paths: [] })).toEqual({ applied: [], conflicts: [], refused: [] }); }
    finally { await discardShadow(s); }
  });
});

// Opt-in: drives the REAL installed Claude Code (costs a few cents of the user's own credits). OMNIFORGE_LIVE_CLI=1 pnpm --filter @omniforge/server test agentrun
const live = process.env.OMNIFORGE_LIVE_CLI === "1";
describe.skipIf(!live)("LIVE: real Claude Code in a shadow copy", () => {
  it("creates a file in the copy only, a hostile project hook does not run, and the reviewed file can be applied", async () => {
    const info = (await detectClis()).find((c) => c.id === "claude-code");
    if (!info?.path || info.status === "not-installed") return;
    const canary = path.join(tmp, "HOOK_CANARY"); mk(".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `touch ${canary}` }] }] } }));
    const s = await createShadow(proj, { tmp });
    try {
      const ev = []; for await (const e of runClaudeAgent(s, { cliPath: info.path, prompt: "Create a file named hello.txt containing exactly: hi there. Then stop.", maxBudgetUsd: 1, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|ANTHROPIC)/.test(k)).map(([k, v]) => [k, v!])), timeoutMs: 180_000 })) ev.push(e);
      expect(ev.at(-1), JSON.stringify(ev.at(-1))).toMatchObject({ type: "result", ok: true });
      expect(ev.some((e) => e.type === "tool" && e.name === "Write")).toBe(true);
      expect(fs.existsSync(path.join(proj, "hello.txt"))).toBe(false); expect(fs.existsSync(canary)).toBe(false);
      const ch = await listChanges(s); expect(ch.map((c) => `${c.status}:${c.path}`)).toEqual(["added:hello.txt"]);
      expect((await readSides(s, "hello.txt")).next).toBe("hi there");
      expect((await applyChanges(s, { paths: ["hello.txt"] })).applied).toEqual(["hello.txt"]); expect(fs.readFileSync(path.join(proj, "hello.txt"), "utf8")).toBe("hi there");
    } finally { await discardShadow(s); }
  }, 240_000);

  it("an MCP tool approved for the run is really called by the CLI (a value only the MCP server knows reaches the diff)", async () => {
    const info = (await detectClis()).find((c) => c.id === "claude-code");
    if (!info?.path || info.status === "not-installed") return;
    const secret = `codeword-${crypto.randomBytes(5).toString("hex")}`; const server = new URL("./fixtures/mini-mcp.mjs", import.meta.url).pathname;
    const s = await createShadow(proj, { tmp });
    try {
      const ev = []; for await (const e of runClaudeAgent(s, { cliPath: info.path, prompt: "Use the lookup tool from the MCP server named mini to get the project code word, then create a file named codeword.txt containing exactly that word. Then stop.", maxBudgetUsd: 1, mcpServers: [{ name: "mini", command: process.execPath, args: [server, secret] }], env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|ANTHROPIC)/.test(k)).map(([k, v]) => [k, String(v)])) })) ev.push(e);
      expect(ev.at(-1), JSON.stringify(ev.slice(-3))).toMatchObject({ type: "result", ok: true });
      expect(ev.some((e) => e.type === "tool" && e.name === "mcp__mini__lookup" && /mini \(MCP\): lookup/.test(e.summary))).toBe(true);
      expect((await readSides(s, "codeword.txt")).next?.trim()).toBe(secret);
      expect(fs.existsSync(path.join(proj, "codeword.txt"))).toBe(false);
    } finally { await discardShadow(s); }
  }, 240_000);
});
