/**
 * The OmniForge bridge: an authenticated loopback HTTP service that exposes
 * approved local capabilities to the desktop UI and (after pairing) to the
 * hosted web app. Binds to 127.0.0.1 only. Every route declares the scope it
 * needs; dangerous scopes can be granted only by the desktop UI.
 */
import http from "node:http";
import path from "node:path";
import { analyzeSnapshot, assessRip, discoverLocalServices, effective, investigateSource, type Investigation } from "@omniforge/core";
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
import type { Deobfuscator } from "@omniforge/core";

export interface BridgeOptions { port?: number; uiToken?: string; version?: string; allowedOrigins?: string[]; jobsDir?: string; reaDir?: string }
export interface Bridge { url: string; port: number; auth: BridgeAuth; roots: Roots; jobs: JobManager; close(): Promise<void> }

const ndjson = (lines: Iterable<string>) => { const enc = new TextEncoder(); const it = lines[Symbol.iterator](); return new Response(new ReadableStream<Uint8Array>({ pull(c) { const n = it.next(); if (n.done) c.close(); else c.enqueue(enc.encode(n.value)); } }), { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } }); };

export async function startBridge(o: BridgeOptions = {}): Promise<Bridge> {
  const roots = new Roots();
  const jobs = new JobManager({ dir: o.jobsDir });
  const rea = new ReaJobs(jobs, o.reaDir);
  let renderer: PlaywrightRenderer | null = null;
  const getRenderer = () => (renderer ??= new PlaywrightRenderer({ allowPrivate: true }));
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
      const hdr: Record<string, string> = {};
      for (const [k, v] of Object.entries<string>(b.headers ?? {})) if (/^(authorization|x-api-key|anthropic-version|anthropic-beta|anthropic-dangerous-direct-browser-access|content-type|accept|x-goog-api-key|http-referer|x-title|openai-organization)$/i.test(k)) hdr[k.toLowerCase()] = String(v);
      const method = String(b.method ?? "GET").toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return err("Unsupported method");
      let up: globalThis.Response;
      try { up = await fetch(target, { method, headers: hdr, body: method === "GET" ? undefined : (b.body ?? undefined), redirect: "manual", signal: req.signal }); }
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
      const inv = await investigateSource(root(b.root).label, files, { kind: "folder", origin: `local:${root(b.root).label}` });
      inv.limitations.push(...skipped.slice(0, 20).map((s) => `${s.path}: ${s.reason}`));
      return json(inv);
    }
    if (is("POST", "/bridge/inspect-package")) {
      need(p, "fs:read"); const b = await readJson(req, 4000);
      const abs = await roots.resolve(b.root, b.path ?? ".", { mustExist: true });
      const report = await inspectPath(abs);
      const inv = report.files.length ? await investigateSource(report.name, report.files, { kind: "files", origin: abs }) : null;
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
    async close() { await jobs.shutdown(); await renderer?.close(); await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }); },
  };
}
export type { Investigation };
