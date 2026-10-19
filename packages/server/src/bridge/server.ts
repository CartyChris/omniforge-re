/**
 * The OmniForge bridge: an authenticated loopback HTTP service that exposes
 * approved local capabilities to the desktop UI and (after pairing) to the
 * hosted web app. Binds to 127.0.0.1 only. Every route declares the scope it
 * needs; dangerous scopes can be granted only by the desktop UI.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { analyzeSnapshot, assessRip, AGENT_CLIS, buildAgentPrompt, claudeAgentArgs, planAgentRun, type AgentCliId, discoverLocalServices, effective, investigateSource, type AgentEvent, type Investigation } from "@omniforge/core";
import { analyzeHandler, probeHandler } from "../handlers.js";
import { HttpError, UserError, bytesToB64, err, json, readJson, sse } from "../http.js";
import { BlockedUrlError, ProviderError, RightsError } from "@omniforge/core";
import { AuthError, BridgeAuth, need, type Principal, type Scope, DANGEROUS_SCOPES } from "./auth.js";
import { readChanges, restoreBackup, listBackups } from "./changelog.js";
import { ADAPTERS, detectClis, probeCli, runCli, testCli } from "./clis.js";
import { detectLocalRuntimes, detectTools, systemInfo } from "./detect.js";
import { FsError, Roots, deleteFile, listTree, readText, snapshotFolder, writeText } from "./fsx.js";
import { cloneToSnapshot, gitCheckout, gitCommitAll, gitDiff, gitInit, gitLog, gitStatus } from "./git.js";
import { JobManager } from "./jobs.js";
import { inspectPath } from "./package.js";
import { applyReaInstall, planReaInstall, ReaJobs, REA_OPS, reaStatus, reaSummary, reaToInvestigation } from "./rea.js";
import { findChrome, PlaywrightRenderer } from "./render.js";
import { verifyUrls } from "./verify.js";
import { AgentRuns, applyChanges, createShadow, listChanges, readSides, runAgentCli, runClaudeAgent } from "./agentrun.js";
import { backupFiles, record as recordChange } from "./changelog.js";
import type { Deobfuscator } from "@omniforge/core";
import { scanSkills } from "./skills.js";
import { McpHub, specFrom } from "./mcp.js";
import { nodeNet } from "../net.js";
import { exchangeOpenRouterCode, openRouterAuthUrl, pkcePair } from "@omniforge/core";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { nodeStructureExtractor } from "@omniforge/structure/node";

export interface BridgeOptions { port?: number; uiToken?: string; version?: string; allowedOrigins?: string[]; jobsDir?: string; reaDir?: string; /** tests only: drive this executable as "Claude Code" instead of the installed one */ agentCliPath?: string; /** tests only: drive these executables as the named agent CLIs */ agentCliPaths?: Record<string, string>; /** tests only: home folder to scan for Agent Skills */ skillsHome?: string; /** tests only: how sign-in pages are opened and codes exchanged */ openUrl?: (url: string) => void; oauthFetch?: typeof fetch }
export interface Bridge { url: string; port: number; auth: BridgeAuth; roots: Roots; jobs: JobManager; close(): Promise<void> }

const ndjson = (lines: Iterable<string>) => { const enc = new TextEncoder(); const it = lines[Symbol.iterator](); return new Response(new ReadableStream<Uint8Array>({ pull(c) { const n = it.next(); if (n.done) c.close(); else c.enqueue(enc.encode(n.value)); } }), { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } }); };

export async function startBridge(o: BridgeOptions = {}): Promise<Bridge> {
  const roots = new Roots();
  const jobs = new JobManager({ dir: o.jobsDir });
  const rea = new ReaJobs(jobs, o.reaDir);
  let renderer: PlaywrightRenderer | null = null;
  const getRenderer = () => (renderer ??= new PlaywrightRenderer({ allowPrivate: true }));
  const agentRuns = new AgentRuns(); const mcpHub = new McpHub();
  const oauth = new Map<string, { verifier: string; at: number; key?: string; error?: string }>();
  const openUrl = o.openUrl ?? ((u: string) => { execFile(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [u], () => {}); });
  const structure = nodeStructureExtractor(); // tree-sitter grammars are read from disk on first use
  // webcrack + the QuickJS sandbox are loaded only when a deobfuscation is first requested
  let deob: Deobfuscator | null = null;
  const getDeobfuscator = (): Deobfuscator => (deob ??= { deobfuscate: async (code, run) => (await import("../deobfuscate.js")).createDeobfuscator().deobfuscate(code, run) });
  let auth!: BridgeAuth;
  let cache: { at: number; data: unknown } | null = null;
  let rejectLogged = 0;
  const version = o.version ?? "0.1.0";

  const route = async (req: Request, p: Principal | null, url: URL): Promise<Response> => {
    const m = req.method, pathn = url.pathname;
    const is = (method: string, pat: string | RegExp) => m === method && (typeof pat === "string" ? pathn === pat : pat.test(pathn));
    const ui = (): Principal => { if (!p) throw new AuthError(401, "Not authenticated."); if (p.kind !== "ui") throw new AuthError(403, "This action can only be approved from the OmniForge desktop app."); return p; };
    const root = (id: string) => roots.get(id);

    if (is("GET", "/bridge/health")) return json({ ok: true, name: "omniforge-bridge", version, pairingRequired: true });
    if (is("POST", "/bridge/pair")) { const b = await readJson(req, 2000); const s = auth.pair(String(b.code ?? ""), req.headers.get("origin")); return json({ ...s, version }); }
    if (is("POST", "/bridge/ui/pairing-code")) { ui(); return json(auth.newPairingCode()); }
    if (is("GET", "/bridge/sessions")) { ui(); return json(auth.listSessions()); }
    let mm: RegExpMatchArray | null;
    if ((mm = pathn.match(/^\/bridge\/sessions\/([a-f0-9]+)\/scope$/)) && m === "POST") { ui(); const b = await readJson(req, 2000); if (![...DANGEROUS_SCOPES, "analyze", "models", "detect"].includes(b.scope)) return err("Unknown scope"); return json({ ok: auth.grantScope(mm[1]!, b.scope as Scope, b.on !== false) }); }
    if ((mm = pathn.match(/^\/bridge\/sessions\/([a-f0-9]+)$/)) && m === "DELETE") { ui(); auth.revokeSession(mm[1]!); return json({ ok: true }); }

    /* ---- detection ---- */
    if (is("GET", "/bridge/info")) {
      need(p, "detect");
      if (!cache || Date.now() - cache.at > 20_000 || url.searchParams.get("refresh")) {
        const [system, tools, clis, runtimes, reaS] = await Promise.all([systemInfo(), detectTools(), detectClis(), detectLocalRuntimes(), reaStatus({ light: true })]);
        cache = { at: Date.now(), data: { version, system, tools, clis, runtimes, rea: reaS, chrome: findChrome() } };
      }
      return json({ ...(cache.data as object), roots: roots.list().map((r) => ({ id: r.id, label: r.label, writable: r.writable, path: p!.kind === "ui" ? r.path : undefined })) });
    }
    if (is("GET", "/bridge/models")) { need(p, "models"); const [svc, clis] = await Promise.all([discoverLocalServices(), detectClis()]); return json({ services: svc, clis: clis.filter((c) => c.status === "ready").map((c) => ({ id: c.id, name: c.name, method: c.method })) }); }

    /* ---- local model servers + API forwarding (so a hosted page never has to touch localhost directly) ---- */
    if (is("POST", "/bridge/forward")) {
      need(p, "models");
      const b = await readJson(req, 30_000_000);
      let target: URL;
      try { target = new URL(String(b.url)); } catch { return err("Invalid URL"); }
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
      if (loopback) {
        const port = Number(target.port || 80);
        const extra = (process.env.OMNIFORGE_LOCAL_PORTS ?? "").split(",").map(Number).filter(Boolean);
        if (![11434, 1234, 8080, 8000, 8888, 8001, 5000, 7860, 1337, ...extra].includes(port) || target.protocol !== "http:") return err(`Only http on known local model ports is forwarded (got ${target.host}). Set OMNIFORGE_LOCAL_PORTS to add one.`, 403);
        if (target.pathname.includes("..")) return err("Invalid path");
      } else {
        const { FORWARD_ALLOW } = await import("../handlers.js");
        if (target.protocol !== "https:" || !FORWARD_ALLOW.has(target.hostname)) return err(`${target.hostname} is not an allowed API host.`, 403);
      }
      const { forwardedBody } = await import("../handlers.js");
      let payload: string | Uint8Array<ArrayBuffer> | undefined;
      try { payload = forwardedBody(b); } catch (e) { return err((e as Error).message, 400); }
      const hdr: Record<string, string> = {};
      for (const [k, v] of Object.entries<string>(b.headers ?? {})) if (/^(authorization|x-api-key|anthropic-version|anthropic-beta|anthropic-dangerous-direct-browser-access|content-type|accept|x-goog-api-key|http-referer|x-title|openai-organization)$/i.test(k)) hdr[k.toLowerCase()] = String(v);
      const method = String(b.method ?? "GET").toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return err("Unsupported method");
      let up: globalThis.Response;
      try { up = await fetch(target, { method, headers: hdr, body: method === "GET" ? undefined : payload, redirect: "manual", signal: req.signal }); }
      catch (e) { const cause = (e as { cause?: { code?: string } }).cause?.code; return err(loopback ? `Nothing is listening on ${target.host}${cause ? ` (${cause})` : ""}. Is the model server running?` : `Upstream request failed: ${(e as Error).message}`, 502); }
      if (up.status >= 300 && up.status < 400) return err("Redirects are not followed", 502);
      const h = new Headers(); for (const k of ["content-type", "retry-after"]) if (up.headers.get(k)) h.set(k, up.headers.get(k)!);
      return new Response(up.body, { status: up.status, headers: h });
    }

    /* ---- roots & filesystem ---- */
    if (is("GET", "/bridge/roots")) { need(p, "fs:read"); return json(roots.list().map((r) => ({ id: r.id, label: r.label, writable: r.writable }))); }
    if (is("POST", "/bridge/roots")) { ui(); const b = await readJson(req, 4000); const r = await roots.add(String(b.path), { label: b.label, writable: !!b.writable }); return json(r); }
    if ((mm = pathn.match(/^\/bridge\/roots\/([\w-]+)$/)) && m === "DELETE") { ui(); return json({ ok: roots.remove(mm[1]!) }); }
    if (is("GET", "/bridge/fs/tree")) { need(p, "fs:read"); return json(await listTree(roots, url.searchParams.get("root") ?? "", { sub: url.searchParams.get("sub") ?? undefined })); }
    if (is("GET", "/bridge/fs/read")) { need(p, "fs:read"); return json(await readText(roots, url.searchParams.get("root") ?? "", url.searchParams.get("path") ?? "")); }
    if (is("POST", "/bridge/fs/write")) { need(p, "fs:write"); const b = await readJson(req, 5_000_000); return json(await writeText(roots, b.root, b.path, String(b.content ?? ""))); }
    if (is("POST", "/bridge/fs/delete")) { need(p, "fs:write"); const b = await readJson(req, 4000); return json(await deleteFile(roots, b.root, String(b.path))); }
    if (is("POST", "/bridge/analyze-folder")) {
      need(p, "fs:read"); const b = await readJson(req, 4000);
      const { files, skipped } = await snapshotFolder(roots, b.root, { sub: b.sub });
      const inv = await investigateSource(root(b.root).label, files, { kind: "folder", origin: `local:${root(b.root).label}`, structure });
      inv.limitations.push(...skipped.slice(0, 20).map((s) => `${s.path}: ${s.reason}`));
      return json(inv);
    }
    if (is("POST", "/bridge/inspect-package")) {
      need(p, "fs:read"); const b = await readJson(req, 4000);
      const abs = await roots.resolve(b.root, b.path ?? ".", { mustExist: true });
      const report = await inspectPath(abs);
      const inv = report.files.length ? await investigateSource(report.name, report.files, { kind: "files", origin: abs, structure }) : null;
      return json({ report: { ...report, files: report.files.map((f) => f.path) }, investigation: inv });
    }

    /* ---- jobs (arbitrary commands: explicit exec scope + approved root) ---- */
    if (is("POST", "/bridge/jobs")) {
      need(p, "exec"); const b = await readJson(req, 20_000); const r = root(b.root);
      if (!r.writable && b.write) throw new FsError(403, "Folder is read-only");
      const meta = b.shell ? jobs.start({ kind: "exec", cmd: String(b.command), shell: true, cwd: r.path, timeoutMs: Math.min(Number(b.timeoutMs) || 600_000, 3_600_000) }) : jobs.start({ kind: "exec", cmd: String(b.cmd), args: (b.args ?? []).map(String), cwd: r.path, timeoutMs: Math.min(Number(b.timeoutMs) || 600_000, 3_600_000) });
      return json(meta);
    }
    if (is("GET", "/bridge/jobs")) { need(p, "exec"); return json(jobs.list()); }
    if ((mm = pathn.match(/^\/bridge\/jobs\/([a-f0-9]+)\/stream$/)) && m === "GET") {
      need(p, "exec");
      return sse(async (send, signal) => { await new Promise<void>((resolve) => { const un = jobs.subscribe(mm![1]!, (l) => { if ("end" in l) { send("end", l.end); un(); resolve(); } else send("line", l); }, Number(url.searchParams.get("from") ?? 0)); signal.addEventListener("abort", () => { un(); resolve(); }, { once: true }); }); }, req);
    }
    if ((mm = pathn.match(/^\/bridge\/jobs\/([a-f0-9]+)\/cancel$/)) && m === "POST") { need(p, "exec"); return json({ ok: jobs.cancel(mm[1]!) }); }

    /* ---- REA ---- */
    if (is("GET", "/bridge/rea/status")) { need(p, "rea"); return json(await reaStatus()); }
    if (is("GET", "/bridge/rea/ops")) { need(p, "rea"); return json(REA_OPS.map((o) => ({ id: o.id, label: o.label, kind: o.kind, accepts: o.accepts, platforms: o.platforms }))); }
    if (is("GET", "/bridge/rea/install-plan")) { need(p, "rea"); return json(planReaInstall()); }
    if (is("POST", "/bridge/rea/install")) { ui(); const b = await readJson(req, 2000); return json(applyReaInstall(jobs, { approved: b.approved === true })); }
    if (is("POST", "/bridge/rea/jobs")) { need(p, "rea"); const b = await readJson(req, 4000); const abs = await roots.resolve(b.root, b.path ?? ".", { mustExist: true }); return json(rea.start(String(b.op), abs, { provider: b.provider, type: b.type, approveLaunch: b.approveLaunch === true })); }
    if ((mm = pathn.match(/^\/bridge\/rea\/jobs\/([a-f0-9]+)\/result$/)) && m === "GET") {
      need(p, "rea");
      const env = rea.result(mm[1]!);
      if (!env) return err("No result yet (job still running, failed, or produced no JSON).", 404);
      const view = url.searchParams.get("view") ?? "summary";
      if (view === "investigation") return json(reaToInvestigation(env, { targetPath: env.subject?.local_path }));
      if (view === "raw") return json(env);
      return json(reaSummary(env));
    }

    /* ---- AI CLIs ---- */
    if (is("GET", "/bridge/cli")) { need(p, "cli"); return json(await detectClis()); }
    if (is("POST", "/bridge/cli/test")) { need(p, "cli"); const b = await readJson(req, 2000); const a = ADAPTERS.find((x) => x.id === b.id); if (!a) return err("Unknown CLI"); const info = await probeCli(a); return json({ ...info, verified: await testCli(a, info) }); }
    if (is("POST", "/bridge/cli/run")) {
      need(p, "cli"); const b = await readJson(req, 2_000_000);
      const a = ADAPTERS.find((x) => x.id === b.id); if (!a) return err("Unknown CLI");
      const info = await probeCli(a);
      const cwd = b.root ? root(b.root).path : undefined;
      if (a.agentic && cwd && !root(b.root).writable) return err("This CLI can edit files; approve the folder as writable first.", 403);
      return sse(async (send, signal) => { for await (const e of runCli(a, info, { prompt: String(b.prompt ?? ""), model: b.model, cwd, signal, timeoutMs: 900_000 })) send(e.type, e); send("end", {}); }, req);
    }

    /* ---- CLI-direct agent runs: the CLI edits an isolated copy; changes reach the project only through a reviewed apply ---- */
    if (is("POST", "/bridge/cli/login")) {
      // Opens the CLI's own sign-in (a fixed command per CLI, never user input) in Terminal; the CLI stores its own credentials.
      ui(); const b = await readJson(req, 2000); const a = ADAPTERS.find((x) => x.id === b.id); if (!a?.login) return err("This CLI has no sign-in command (it uses API keys).", 400);
      const info = await probeCli(a); if (!info.path) return err(`${a.name} is not installed. ${a.install}`, 400);
      const command = [info.path, ...a.login.slice(1)].map((x) => (/^[\w./@:-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`)).join(" ");
      if (process.platform === "darwin" && !o.openUrl) { execFile("osascript", ["-e", 'tell application "Terminal" to activate', "-e", `tell application "Terminal" to do script ${JSON.stringify(command)}`], () => {}); return json({ opened: true, command }); }
      return json({ opened: false, command });
    }

    /* ---- CLI-direct agent runs: the CLI edits an isolated copy; changes reach the project only through a reviewed apply ---- */
    if (is("POST", "/bridge/agent/run")) {
      need(p, "cli"); need(p, "fs:read"); const b = await readJson(req, 2_000_000);
      const cliId = String(b.cli ?? ""); const caps = AGENT_CLIS.find((c) => c.id === cliId); if (!caps) return err(`Unknown agent CLI “${cliId.slice(0, 40)}”.`, 400);
      const a = ADAPTERS.find((x) => x.id === cliId)!; const override = o.agentCliPaths?.[cliId] ?? (cliId === "claude-code" ? o.agentCliPath : undefined);
      const info = override ? { ...(await probeCli(a)), path: override, status: "ready" as const } : await probeCli(a);
      if (!info.path || info.status === "not-installed") return err(`${a.name} is not installed on this Mac. ${a.install}`, 400);
      if (info.status === "unsupported-invocation") return err(`This version of ${a.name} does not expose the non-interactive mode this app needs.`, 400);
      const rt = root(b.root); const prompt = buildAgentPrompt(String(b.prompt ?? ""), typeof b.brief === "string" ? b.brief : undefined);
      const budget = Math.min(20, Math.max(0.1, Number(b.maxBudgetUsd) || 2));
      // Only well-formed server entries are forwarded (names, commands and addresses are re-validated by core before anything runs).
      const mcpServers = Array.isArray(b.mcpServers) ? b.mcpServers.slice(0, 9).map((m: any) => ("url" in (m ?? {}) ? { name: String(m.name), url: String(m.url) } : { name: String(m?.name), command: String(m?.command), args: Array.isArray(m?.args) ? m.args.map(String) : [] })) : [];
      if (mcpServers.length && !caps.mcp) return err(`${caps.label} does not support MCP servers.`, 400);
      const allowedCommands = Array.isArray(b.allowedCommands) ? b.allowedCommands.map(String).slice(0, 12) : [];
      if (allowedCommands.length && caps.commands === "none") return err(`${caps.label} cannot run commands in agent mode.`, 400);
      const model = typeof b.model === "string" && /^[\w.:/@+-]{1,120}$/.test(b.model) ? b.model : undefined;
      // Aider: a model and (optionally) an API key the user chose in OmniForge; only known key variable names and http(s) bases are accepted
      const AIDER_KEYS = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY"];
      const aider = cliId === "aider" ? { model: String(b.aider?.model ?? ""), keyEnv: AIDER_KEYS.includes(b.aider?.keyEnv) ? b.aider.keyEnv : undefined, key: typeof b.aider?.key === "string" ? b.aider.key.slice(0, 400) : undefined, apiBase: typeof b.aider?.apiBase === "string" && /^https?:\/\/[^\s]+$/.test(b.aider.apiBase) ? b.aider.apiBase : undefined } : undefined;
      try {
        if (cliId === "claude-code") claudeAgentArgs({ mcpServers, mcpConfigPath: "x", allowedCommands });
        else planAgentRun(cliId as Exclude<AgentCliId, "claude-code">, { prompt, model, allowedCommands, mcpServers, aider, work: "/x", runDir: "/x" });
      } catch (e) { return err((e as Error).message, 400); }
      return sse(async (send, signal) => {
        const shadow = await createShadow(rt.path); agentRuns.add(shadow, String(b.root));
        send("start", { runId: shadow.id, copied: shadow.copied, bytes: shadow.bytes, skipped: shadow.skipped.slice(0, 100), cli: info.version, cliName: a.name });
        let result: AgentEvent | undefined;
        const events = cliId === "claude-code"
          ? runClaudeAgent(shadow, { cliPath: info.path!, prompt, model, allowedCommands, mcpServers, maxBudgetUsd: budget, signal })
          : runAgentCli(shadow, { cli: cliId as Exclude<AgentCliId, "claude-code">, cliPath: info.path!, prompt, model, allowedCommands, mcpServers, aider, signal });
        for await (const e of events) { send("event", e); if (e.type === "result") result = e; }
        send("done", { runId: shadow.id, ok: result?.type === "result" && result.ok, result, changes: await listChanges(shadow) });
      }, req);
    }
    if ((mm = pathn.match(/^\/bridge\/agent\/runs\/([a-f0-9]{16})(?:\/(changes|file|apply))?$/))) {
      need(p, "cli"); const run = agentRuns.get(mm[1]!);
      if (m === "DELETE" && !mm[2]) { await agentRuns.discard(mm[1]!); return json({ ok: true }); }
      if (m === "GET" && mm[2] === "changes") return json({ changes: await listChanges(run.shadow) });
      if (m === "GET" && mm[2] === "file") return json(await readSides(run.shadow, url.searchParams.get("path") ?? ""));
      if (m === "POST" && mm[2] === "apply") {
        need(p, "fs:write"); const b = await readJson(req, 200_000); const rt = root(run.rootId);
        if (!rt.writable) return err("Approve this folder as writable before applying changes.", 403);
        const paths: string[] = Array.isArray(b.paths) ? b.paths.map(String).slice(0, 2000) : [];
        // back up what will be overwritten or deleted so Applications → Restore can undo the apply
        const existing = (await listChanges(run.shadow)).filter((c) => paths.includes(c.path) && c.status !== "added").map((c) => path.join(run.shadow.rootPath, c.path)).filter((f) => fs.existsSync(f));
        const backup = existing.length ? backupFiles(existing) : null;
        const result = await applyChanges(run.shadow, { paths, allowDeletes: !!b.allowDeletes });
        if (result.applied.length) recordChange({ action: "agent-apply", detail: `Applied ${result.applied.length} file(s) from a Claude Code run to ${rt.label}`, backup: backup?.dir, files: result.applied });
        return json({ ...result, backup: backup?.dir ?? null });
      }
      return err("Not found", 404);
    }

    /* ---- git / repos ---- */
    if (is("POST", "/bridge/repo/inspect")) {
      need(p, "git"); const b = await readJson(req, 100_000); const urls: string[] = (b.urls ?? []).slice(0, 8);
      const results = await Promise.all(urls.map(async (u) => { try { const s = await analyzeSnapshot(await cloneToSnapshot(u, { token: b.token })); const a = s.analysis!; return { ok: true as const, url: u, ref: s.ref, sha: s.sha, licenses: s.licenses, effective: effective(s.licenses), files: s.files.length, bytes: s.files.reduce((n, f) => n + f.data.byteLength, 0), skipped: s.skipped.length, languages: a.languages.slice(0, 8), frameworks: a.frameworks, buildSystems: a.buildSystems, entrypoints: a.entrypoints.slice(0, 12), routes: a.routes.length, components: a.components.length, dependencies: a.dependencies.length, envVars: a.envVars.map((e) => e.name), database: a.databaseDefinitions, tree: s.files.map((f) => f.path).slice(0, 3000) }; } catch (e) { return { ok: false as const, url: u, error: (e as Error).message }; } }));
      const good = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
      return json({ repos: results, assessment: good.length ? assessRip(good.map((r) => ({ repo: `${r.ref.owner}/${r.ref.repo}`, licenses: r.licenses })), b.purpose ?? "clone") : null });
    }
    if (is("POST", "/bridge/repo/files")) {
      need(p, "git"); const b = await readJson(req, 20_000);
      const s = await cloneToSnapshot(String(b.url), { token: b.token });
      return ndjson((function* () { yield JSON.stringify({ header: { ref: s.ref, sha: s.sha, licenses: s.licenses, skipped: s.skipped, fetchedAt: s.fetchedAt, method: s.method, count: s.files.length } }) + "\n"; for (const f of s.files) yield JSON.stringify({ path: f.path, b64: bytesToB64(f.data) }) + "\n"; })());
    }
    if (is("POST", "/bridge/git/status")) { need(p, "git"); const b = await readJson(req, 2000); return json(await gitStatus(root(b.root).path)); }
    if (is("POST", "/bridge/git/diff")) { need(p, "git"); const b = await readJson(req, 4000); return json({ diff: await gitDiff(root(b.root).path, b.file) }); }
    if (is("POST", "/bridge/git/log")) { need(p, "git"); const b = await readJson(req, 2000); return json(await gitLog(root(b.root).path)); }
    if (is("POST", "/bridge/git/init")) { need(p, "git"); need(p, "fs:write"); const b = await readJson(req, 2000); if (!root(b.root).writable) throw new FsError(403, "Folder is read-only"); return json({ ok: await gitInit(root(b.root).path) }); }
    if (is("POST", "/bridge/git/commit")) { need(p, "git"); need(p, "fs:write"); const b = await readJson(req, 8000); if (!root(b.root).writable) throw new FsError(403, "Folder is read-only"); return json(await gitCommitAll(root(b.root).path, String(b.message ?? "Update"))); }
    if (is("POST", "/bridge/git/checkout")) { need(p, "git"); need(p, "fs:write"); const b = await readJson(req, 2000); return json(await gitCheckout(root(b.root).path, String(b.branch), !!b.create)); }

    /* ---- browser rendering + full local analysis ---- */
    if (is("GET", "/bridge/render/status")) { need(p, "render"); const c = findChrome(); return json({ available: !!c, path: c }); }
    if (is("POST", "/bridge/verify")) { need(p, "render"); const b = await readJson(req, 4000); return json(await verifyUrls(getRenderer(), b.reference, b.rebuilt)); }
    if (is("POST", "/bridge/probe")) { need(p, "analyze"); return probeHandler(req, { mode: "local" }); }
    if (is("POST", "/bridge/analyze")) {
      need(p, "analyze");
      const body = await req.clone().json().catch(() => ({}));
      const wantsRender = !!body?.config?.render;
      if (wantsRender) need(p, "render");
      return analyzeHandler(req, { mode: "local", renderer: wantsRender ? getRenderer() : undefined, deobfuscator: body?.config?.deobfuscate ? getDeobfuscator() : undefined });
    }
    /* ---- MCP servers for OmniForge's own agents: starting a stdio server runs a program as the user, so it needs the exec permission ---- */
    if (is("POST", "/bridge/mcp/connect")) {
      need(p, "exec"); const b = await readJson(req, 100_000); const list: ReturnType<typeof specFrom>[] = Array.isArray(b.servers) ? b.servers.slice(0, 8).map(specFrom) : [];
      return json({ servers: await Promise.all(list.map(async (spec: ReturnType<typeof specFrom>) => { try { const c = await mcpHub.connect(spec); return { name: spec.name, ok: true, serverInfo: c.serverInfo, tools: c.tools }; } catch (e) { return { name: spec.name, ok: false, error: (e as Error).message }; } })) });
    }
    if (is("POST", "/bridge/mcp/call")) {
      need(p, "exec"); const b = await readJson(req, 2_000_000);
      try { return json(await mcpHub.call(specFrom(b.server), String(b.tool ?? ""), b.args && typeof b.args === "object" ? b.args : {})); } catch (e) { return err((e as Error).message, 400); }
    }
    if (is("POST", "/bridge/mcp/disconnect")) { need(p, "exec"); const b = await readJson(req, 100_000); for (const s of Array.isArray(b.servers) ? b.servers.slice(0, 8) : []) await mcpHub.disconnect(specFrom(s)); return json({ ok: true }); }
    /* ---- "Sign in with OpenRouter" (OAuth PKCE): the browser comes back to this loopback engine, which exchanges the code for a key ---- */
    if (is("POST", "/bridge/oauth/openrouter/start")) {
      ui(); for (const [k, v] of oauth) if (Date.now() - v.at > 15 * 60_000) oauth.delete(k);
      const state = crypto.randomBytes(16).toString("hex"); const { verifier, challenge } = await pkcePair(); oauth.set(state, { verifier, at: Date.now() });
      const authUrl = openRouterAuthUrl(`http://${url.host}/bridge/oauth/openrouter/callback/${state}`, challenge); openUrl(authUrl);
      return json({ state, url: authUrl });
    }
    if ((mm = pathn.match(/^\/bridge\/oauth\/openrouter\/callback\/([a-f0-9]{32})$/)) && m === "GET") {
      const st = oauth.get(mm[1]!); const page = (title: string, body: string, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3rem;max-width:36rem"><h1>${title}</h1><p>${body}</p></body>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
      if (!st || st.key || st.error) return page("Sign-in link expired", "Start “Sign in with OpenRouter” again from OmniForge RE.", 400);
      const code = url.searchParams.get("code") ?? "";
      try { st.key = await exchangeOpenRouterCode(code, st.verifier, { fetch: o.oauthFetch ?? (nodeNet({ allowPrivate: false }).fetch as unknown as typeof fetch) }); return page("Signed in to OpenRouter", "You can close this tab and return to OmniForge RE."); }
      catch (e) { st.error = (e as Error).message; return page("OpenRouter sign-in failed", st.error.replace(/[<>&]/g, ""), 400); }
    }
    if ((mm = pathn.match(/^\/bridge\/oauth\/openrouter\/result\/([a-f0-9]{32})$/)) && m === "GET") {
      ui(); const st = oauth.get(mm[1]!); if (!st) return json({ status: "unknown" });
      if (st.key) { oauth.delete(mm[1]!); return json({ status: "done", key: st.key }); } // handed over once, then forgotten
      if (st.error) { oauth.delete(mm[1]!); return json({ status: "error", error: st.error }); }
      return json({ status: "pending" });
    }
    if (is("GET", "/bridge/skills")) { ui(); return json(scanSkills(o.skillsHome)); }
    if (is("GET", "/bridge/changes")) { ui(); return json({ changes: readChanges(), backups: listBackups() }); }
    if (is("POST", "/bridge/restore")) { ui(); const b = await readJson(req, 2000); return json({ restored: restoreBackup(String(b.dir)) }); }
    return err("Not found", 404);
  };

  const server = http.createServer(async (nreq, nres) => {
    const chunks: Buffer[] = [];
    let size = 0;
    nreq.on("data", (c: Buffer) => { size += c.length; if (size <= 60_000_000) chunks.push(c); });
    nreq.on("end", async () => {
      const url = new URL(nreq.url ?? "/", `http://${nreq.headers.host ?? "127.0.0.1"}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(nreq.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const origin = headers.get("origin");
      const cors: Record<string, string> = {};
      const pubPath = url.pathname === "/bridge/health" ? "*" : url.pathname === "/bridge/pair" ? origin : null;
      const allowed = pubPath ?? auth.allowOrigin(origin);
      if (allowed) Object.assign(cors, { "access-control-allow-origin": allowed, vary: "Origin", "access-control-allow-headers": "authorization, content-type, x-omniforge-bridge", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-max-age": "600" });
      let response: Response;
      try {
        if (!auth.hostOk(headers.get("host"))) throw new AuthError(403, "Bad Host header");
        if (nreq.method === "OPTIONS") response = new Response(null, { status: allowed ? 204 : 403 });
        else {
          auth.requireCsrf(headers, nreq.method ?? "GET");
          const principal = auth.authenticate(headers);
          if (size > 60_000_000) throw new HttpError(413, "Request too large");
          const body = chunks.length && nreq.method !== "GET" && nreq.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
          const ctrl = new AbortController();
          nres.on("close", () => { if (!nres.writableFinished) ctrl.abort(); });
          const req = new Request(url, { method: nreq.method, headers, body, signal: ctrl.signal });
          response = await route(req, principal, url);
        }
      } catch (e) {
        const user = e instanceof UserError || e instanceof BlockedUrlError || e instanceof RightsError || e instanceof ProviderError;
        const status = e instanceof AuthError || e instanceof HttpError || e instanceof FsError ? e.status : user ? 400 : 500;
        response = err(status === 500 ? "Internal error" : (e as Error).message, status);
        if (status === 500) console.error("[bridge]", (e as Error).message);
        // Access-control rejections are logged (never tokens or bodies) so "the app can't connect" is diagnosable from engine.log.
        else if (e instanceof AuthError && rejectLogged++ < 60) console.error(`[bridge] rejected ${status} ${nreq.method} ${url.pathname} origin=${origin ?? "-"} host=${headers.get("host") ?? "-"}: ${(e as Error).message}`);
      }
      const h: Record<string, string> = { ...cors };
      response.headers.forEach((v, k) => (h[k] = v));
      nres.writeHead(response.status, h);
      if (!response.body) return void nres.end();
      const reader = response.body.getReader();
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; if (!nres.write(value)) await new Promise((r) => nres.once("drain", r)); } } catch { /* client went away */ } finally { nres.end(); reader.cancel().catch(() => {}); }
    });
  });

  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(o.port ?? 0, "127.0.0.1", resolve); });
  const port = (server.address() as import("node:net").AddressInfo).port;
  auth = new BridgeAuth({ port, uiToken: o.uiToken, staticOrigins: o.allowedOrigins });
  void path;
  return {
    url: `http://127.0.0.1:${port}`, port, auth, roots, jobs,
    async close() { await mcpHub.closeAll(); await agentRuns.closeAll(); await jobs.shutdown(); await renderer?.close(); await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }); },
  };
}
export type { Investigation };
