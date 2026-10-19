/**
 * OWASP Noir (https://github.com/owasp-noir/noir, MIT): attack-surface / endpoint discovery from source code across many frameworks.
 * Optional: used when the user has `noir` installed (brew install noir). Only the static scan runs — never Noir's AI, probe, export or
 * webhook features, so nothing is sent anywhere. Output parsed here is the real `noir scan -f json` shape (recorded from 1.4.0).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { hashStr, now, type Endpoint, type Evidence, type Investigation } from "@omniforge/core";
import { which } from "./detect.js";
import { sanitizedEnv } from "./jobs.js";

export const noirBinary = (): string | null => {
  if (process.env.NOIR_BIN && fs.existsSync(process.env.NOIR_BIN)) return process.env.NOIR_BIN;
  return which("noir") ?? ["/opt/homebrew/bin/noir", "/usr/local/bin/noir"].find((p) => fs.existsSync(p)) ?? null;
};

export interface NoirEndpoint { method: string; url: string; technology?: string; file?: string; line?: number; params: { name: string; type: string }[] }
export interface NoirResult { ok: boolean; endpoints: NoirEndpoint[]; errors: string[]; ms: number; error?: string }

/** Parse `noir scan -f json` output. Unknown fields are ignored; malformed entries are dropped. */
export function parseNoirJson(text: string): { endpoints: NoirEndpoint[]; errors: string[] } {
  const start = text.indexOf("{"); if (start < 0) throw new Error("Noir produced no JSON");
  const j = JSON.parse(text.slice(start)) as { endpoints?: any[]; errors?: any[] };
  const endpoints: NoirEndpoint[] = [];
  for (const e of Array.isArray(j.endpoints) ? j.endpoints : []) {
    if (!e || typeof e.url !== "string" || !e.url) continue;
    const cp = Array.isArray(e.details?.code_paths) ? e.details.code_paths[0] : undefined;
    endpoints.push({ method: String(e.method || "GET").toUpperCase(), url: e.url.slice(0, 500), technology: typeof e.details?.technology === "string" ? e.details.technology : undefined,
      file: typeof cp?.path === "string" ? cp.path.replace(/^\.\//, "") : undefined, line: Number.isFinite(cp?.line) ? Number(cp.line) : undefined,
      params: (Array.isArray(e.params) ? e.params : []).filter((p: any) => p && typeof p.name === "string").slice(0, 40).map((p: any) => ({ name: String(p.name).slice(0, 100), type: String(p.param_type ?? "") })) });
  }
  return { endpoints, errors: (Array.isArray(j.errors) ? j.errors : []).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).slice(0, 20) };
}

export function runNoir(dir: string, o: { bin?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<NoirResult> {
  const bin = o.bin ?? noirBinary(); const t = Date.now();
  if (!bin) return Promise.resolve({ ok: false, endpoints: [], errors: [], ms: 0, error: "not installed" });
  return new Promise((resolve) => {
    // relative paths in the report: scan "." from inside the folder
    const child = spawn(bin, ["scan", ".", "-f", "json", "--no-log", "--no-color", "--no-spinner", "--passive-scan-no-update-check"], { cwd: dir, env: sanitizedEnv(), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = ""; let done = false;
    const finish = (r: NoirResult) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const kill = () => { try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL"); } catch { /* gone */ } };
    const timer = setTimeout(() => { kill(); finish({ ok: false, endpoints: [], errors: [], ms: Date.now() - t, error: `timed out after ${Math.round((o.timeoutMs ?? 120_000) / 1000)} s` }); }, o.timeoutMs ?? 120_000);
    o.signal?.addEventListener("abort", () => { kill(); finish({ ok: false, endpoints: [], errors: [], ms: Date.now() - t, error: "cancelled" }); }, { once: true });
    child.stdout!.on("data", (d) => { out += d; if (out.length > 50_000_000) { kill(); finish({ ok: false, endpoints: [], errors: [], ms: Date.now() - t, error: "output too large" }); } });
    child.stderr!.on("data", (d) => { err = (err + d).slice(-4000); });
    child.on("error", (e) => finish({ ok: false, endpoints: [], errors: [], ms: Date.now() - t, error: e.message }));
    child.on("close", (code) => {
      if (code !== 0) return finish({ ok: false, endpoints: [], errors: [], ms: Date.now() - t, error: `exited with code ${code}${err.trim() ? `: ${err.trim().split("\n").at(-1)!.slice(0, 200)}` : ""}` });
      try { const p = parseNoirJson(out); finish({ ok: true, ...p, ms: Date.now() - t }); } catch (e) { finish({ ok: false, endpoints: [], errors: [], ms: Date.now() - t, error: `unreadable output: ${(e as Error).message}` }); }
    });
  });
}

const routeKey = (method: string | undefined, url: string) => `${(method ?? "GET").toUpperCase()} ${url.replace(/\{[^}]*\}|:[A-Za-z_]\w*|<[^>]*>|\[[^\]]*\]/g, "{}").replace(/\/+$/, "") || "/"}`;

/** Add Noir's endpoints to a source investigation (de-duplicated against routes OmniForge already found) and record an honest coverage check. */
export function mergeNoir(inv: Investigation, r: NoirResult, version?: string): Investigation {
  const check = { id: "noir", label: "Endpoint discovery (OWASP Noir)" } as const;
  if (!r.ok) { inv.coverage.checks.push({ ...check, status: r.error === "not installed" ? "skipped" : "unavailable", detail: r.error === "not installed" ? "OWASP Noir is not installed (brew install noir) — optional; built-in route extraction still ran" : `Noir failed: ${r.error}` }); return inv; }
  const have = new Set(inv.endpoints.map((e) => routeKey(e.method, e.url)));
  const evidence: Evidence[] = []; const added: Endpoint[] = [];
  for (const e of r.endpoints) {
    const k = routeKey(e.method, e.url); if (have.has(k)) continue; have.add(k);
    const id = `ev_noir_${hashStr(`${k}|${e.file ?? ""}`).slice(0, 12)}`;
    evidence.push({ id, kind: "recovered", method: "owasp-noir", source: e.file ? `${e.file}${e.line ? `:${e.line}` : ""}` : "noir", timestamp: now(), confidence: 0.85, summary: `${e.method} ${e.url}${e.technology ? ` (${e.technology})` : ""}${e.params.length ? ` params: ${e.params.map((p) => `${p.name}${p.type ? `:${p.type}` : ""}`).join(", ")}` : ""}`, related: [] });
    added.push({ url: e.url, method: e.method, kind: /graphql/i.test(e.url) ? "graphql" : e.method === "WS" || /^wss?:/.test(e.url) ? "websocket" : "rest", foundIn: e.file ? `${e.file}${e.line ? `:${e.line}` : ""}` : "noir", evidence: id });
  }
  inv.endpoints = [...inv.endpoints, ...added]; inv.evidence = [...inv.evidence, ...evidence];
  inv.coverage.checks.push({ ...check, status: "done", detail: `Noir${version ? ` ${version}` : ""} found ${r.endpoints.length} endpoint(s) in ${(r.ms / 1000).toFixed(1)} s; ${added.length} were new to this analysis${r.errors.length ? `; ${r.errors.length} analyser warning(s)` : ""}` });
  return inv;
}
