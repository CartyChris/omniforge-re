/**
 * Reverse Engineer Anything (https://github.com/morluto/rea) adapter.
 *
 * Uses the REAL `rea` CLI: availability, version, providers and capabilities are
 * queried from the installed binary; jobs run allow-listed STATIC operations with
 * live progress parsed from REA's `rea_progress` stream; results are the genuine
 * REA evidence envelope. Nothing here fabricates analysis.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CRAWL, hashStr, now, uid, type Evidence, type Feature, type Finding, type Graph, type GraphNode, type Investigation } from "@omniforge/core";
import { UserError } from "../http.js";
import { exec, which } from "./detect.js";
import { backupFiles, record } from "./changelog.js";
import { JobManager, type JobMeta } from "./jobs.js";

export type ReaAvailability = "available" | "not-installed" | "unsupported-platform" | "needs-configuration";
export interface ReaProviderStatus { id: string; name: string; version: string | null; status: ReaAvailability; operations: number; availableOperations: number; reasons: string[]; effects: string[] }
export interface ReaStatus { status: ReaAvailability; path?: string; version?: string; via: "binary" | "none"; providers: ReaProviderStatus[]; doctor?: { name: string; ok: boolean; classification?: string; remediation?: string; detail?: string }[]; mcp: { agent: string; registered: boolean; file: string }[]; detail?: string }

export function reaBinary(): string | null { return process.env.REA_BIN && fs.existsSync(process.env.REA_BIN) ? process.env.REA_BIN : which("rea"); }

export async function reaStatus(o: { light?: boolean } = {}): Promise<ReaStatus> {
  const bin = reaBinary();
  const mcp = discoverReaMcp();
  if (!bin) return { status: "not-installed", via: "none", providers: [], mcp, detail: "REA is not installed. Install it from the Integrations page (you will be shown exactly what changes first)." };
  const v = await exec(bin, ["--version"], { timeoutMs: 15_000 });
  const version = (v.stdout || v.stderr).match(/\d+\.\d+\.\d+/)?.[0];
  if (v.code !== 0 && !version) return { status: "needs-configuration", path: bin, via: "binary", providers: [], mcp, detail: (v.stderr || v.stdout).trim().slice(0, 200) };
  if (o.light) return { status: "available", path: bin, version, via: "binary", providers: [], mcp, detail: "Open Integrations → REA for provider details and readiness checks." };
  const providers = await reaProviders(bin);
  const d = await exec(bin, ["doctor", "--json"], { timeoutMs: 40_000 });
  let doctor: ReaStatus["doctor"];
  try { const j = JSON.parse(d.stdout); doctor = (j.scope_checks ?? []).map((c: any) => ({ name: c.name, ok: !!c.ok, classification: c.classification, remediation: c.remediation, detail: c.detail })); } catch { /* optional */ }
  return { status: "available", path: bin, version, via: "binary", providers, doctor, mcp };
}

export async function reaProviders(bin = reaBinary()): Promise<ReaProviderStatus[]> {
  if (!bin) return [];
  const r = await exec(bin, ["providers", "--json"], { timeoutMs: 40_000 });
  let j: any;
  try { j = JSON.parse(r.stdout); } catch { return []; }
  return (j.capabilities ?? []).map((p: any): ReaProviderStatus => {
    const groups: any[] = p.groups ?? [];
    const ops = groups.flatMap((g) => g.operations ?? []);
    const avail = groups.filter((g) => g.available).flatMap((g) => g.operations ?? []);
    const bad = groups.filter((g) => !g.available);
    const codes = new Set(bad.map((g) => g.availability_code));
    let status: ReaAvailability = bad.length === 0 ? "available" : avail.length ? "available" : [...codes].every((c) => c === "unsupported_host" || c === "unsupported_version") ? "unsupported-platform" : "needs-configuration";
    return { id: p.provider?.id, name: p.provider?.name, version: p.provider?.version ?? null, status, operations: ops.length, availableOperations: avail.length, reasons: [...new Set(bad.map((g) => g.reason).filter(Boolean))] as string[], effects: [...new Set(groups.flatMap((g) => g.effects ?? []))] as string[] };
  });
}

/* ---------------- MCP registration discovery ---------------- */

export function discoverReaMcp(homeDir = os.homedir()): ReaStatus["mcp"] {
  const targets: [string, string, (t: string) => boolean][] = [
    ["Claude Code", path.join(homeDir, ".claude.json"), (t) => /"rea(?:-agents)?"\s*:/.test(t) || /rea-agents/.test(t)],
    ["Claude Code (settings)", path.join(homeDir, ".claude", "settings.json"), (t) => /rea-agents|"rea"\s*:/.test(t)],
    ["Codex", path.join(homeDir, ".codex", "config.toml"), (t) => /\[mcp_servers\.rea\]|rea-agents/.test(t)],
    ["Gemini CLI", path.join(homeDir, ".gemini", "settings.json"), (t) => /rea-agents|"rea"\s*:/.test(t)],
    ["Cursor", path.join(homeDir, ".cursor", "mcp.json"), (t) => /rea-agents|"rea"\s*:/.test(t)],
  ];
  return targets.map(([agent, file, test]) => { let reg = false; try { reg = test(fs.readFileSync(file, "utf8")); } catch { /* file absent */ } return { agent, registered: reg, file }; });
}

/* ---------------- install: plan → approve → backup → run → record ---------------- */

export interface InstallPlan { steps: { id: string; description: string; command?: string; modifies: string[]; interactive?: boolean }[]; backups: string[]; note: string }

export function planReaInstall(homeDir = os.homedir()): InstallPlan {
  const bin = reaBinary();
  return {
    steps: [
      ...(bin ? [] : [{ id: "npm-global", description: "Install the REA CLI from npm (official package: rea-agents)", command: "npm install --global rea-agents@latest", modifies: ["npm global packages (e.g. /usr/local/lib/node_modules or ~/.npm-global)"] }]),
      { id: "register", description: "Register REA’s MCP server and workflow skill with your AI agents. REA’s own setup shows each change and asks which agents to configure; existing configuration is backed up first.", command: "rea setup", modifies: ["Agent MCP configs (Claude Code, Codex, Cursor, Gemini CLI) — only those you select"], interactive: true },
    ],
    backups: [".claude.json", ".claude/settings.json", ".codex/config.toml", ".gemini/settings.json", ".cursor/mcp.json"].map((f) => path.join(homeDir, f)),
    note: "Nothing is changed until you approve. Existing settings are copied to ~/.omniforge/backups/ and every change is recorded in ~/.omniforge/changes.jsonl so it can be restored from Settings → Diagnostics.",
  };
}

export function applyReaInstall(jobs: JobManager, o: { approved: boolean; homeDir?: string }): { job?: JobMeta; backup?: { dir: string; saved: string[] } } {
  if (!o.approved) throw new UserError("Installation was not approved.");
  const plan = planReaInstall(o.homeDir);
  const backup = backupFiles(plan.backups);
  record({ action: "backup", detail: `Backed up ${backup.saved.length} agent config file(s) before REA install`, backup: backup.dir, files: backup.saved });
  const step = plan.steps.find((s) => s.id === "npm-global");
  if (!step) return { backup };
  const job = jobs.start({ kind: "install", label: "Install REA (npm)", cmd: "npm", args: ["install", "--global", "rea-agents@latest"], timeoutMs: 600_000 });
  record({ action: "install", detail: "npm install --global rea-agents@latest (job " + job.id + ")", backup: backup.dir });
  return { job, backup };
}

/* ---------------- jobs ---------------- */

export interface ReaOp { id: string; label: string; needsPath: boolean; kind: "static" | "native-provider"; platforms?: NodeJS.Platform[]; extra?: (o: ReaJobOptions) => string[]; accepts: string }
export interface ReaJobOptions { provider?: string; type?: string; approveLaunch?: boolean }

export const REA_OPS: ReaOp[] = [
  { id: "analyze-javascript-application", label: "JavaScript / Electron application graph", needsPath: true, kind: "static", accepts: "extracted app directory or .asar" },
  { id: "inspect-managed-artifact", label: ".NET assembly identity", needsPath: true, kind: "static", accepts: ".dll / .exe (PE/CLI)" },
  { id: "inspect-managed-members", label: ".NET members & CIL", needsPath: true, kind: "static", accepts: ".dll / .exe (PE/CLI)", extra: (o) => (o.type ? ["--type", o.type] : []) },
  { id: "inspect-go-binary", label: "Go build metadata", needsPath: true, kind: "static", accepts: "Go executable" },
  { id: "inspect-rust-binary", label: "Rust (cargo-auditable) dependencies", needsPath: true, kind: "static", accepts: "Rust executable" },
  { id: "inspect-wasm-artifact", label: "WebAssembly module", needsPath: true, kind: "static", accepts: ".wasm" },
  { id: "inspect-sqlite-database", label: "SQLite database schema", needsPath: true, kind: "static", accepts: ".db / .sqlite" },
  { id: "inspect-artifact", label: "Package / resource inventory", needsPath: true, kind: "static", accepts: "app bundle, archive, directory" },
  { id: "inspect-macho", label: "Mach-O structure", needsPath: true, kind: "static", platforms: ["darwin"], accepts: "Mach-O binary" },
  { id: "inspect-plist", label: "Property list", needsPath: true, kind: "static", platforms: ["darwin"], accepts: "Info.plist" },
  { id: "inspect-signature", label: "Code signature & entitlements", needsPath: true, kind: "static", platforms: ["darwin"], accepts: ".app or binary" },
  { id: "inspect-electron-fuses", label: "Electron fuses", needsPath: true, kind: "static", accepts: "Electron app / binary" },
  { id: "analyze", label: "Native binary overview (needs Hopper, Ghidra or IDA)", needsPath: true, kind: "native-provider", extra: (o) => (o.provider ? ["--provider", o.provider] : []), accepts: "native executable or .app" },
];

export const progressParser = (line: string): JobMeta["progress"] | undefined => {
  const t = line.trim();
  if (!t.startsWith("{")) return undefined;
  try { const j = JSON.parse(t).rea_progress; if (j) return { phase: String(j.phase), completed: Number(j.completed ?? 0), total: Number(j.total ?? 0), message: String(j.message ?? "") }; } catch { /* not progress */ }
  return undefined;
};

export class ReaJobs {
  constructor(private jobs: JobManager, private dir = path.join(process.env.OMNIFORGE_HOME ?? path.join(os.homedir(), ".omniforge"), "rea")) { fs.mkdirSync(this.dir, { recursive: true }); }
  resultPath(jobId: string) { return path.join(this.dir, `${jobId}.json`); }

  start(opId: string, targetPath: string, o: ReaJobOptions = {}): JobMeta {
    const op = REA_OPS.find((x) => x.id === opId);
    if (!op) throw new UserError(`“${opId}” is not an allowed REA operation.`);
    if (op.platforms && !op.platforms.includes(process.platform)) throw new UserError(`${op.label} is not supported on ${process.platform}.`);
    if (op.kind === "native-provider" && !o.approveLaunch) throw new UserError("Native analysis launches Hopper/Ghidra/IDA on your machine; it needs explicit approval.");
    const bin = reaBinary();
    if (!bin) throw new UserError("REA is not installed.");
    if (!path.isAbsolute(targetPath) || targetPath.includes("\0")) throw new UserError("Provide an absolute path.");
    if (!fs.existsSync(targetPath)) throw new UserError(`Not found: ${targetPath}`);
    const tmp = path.join(this.dir, `pending-${uid("r")}.json`);
    const meta = this.jobs.start({ kind: "rea", label: `REA · ${op.label} · ${path.basename(targetPath)}`, cmd: bin, args: [op.id, targetPath, "--json", ...(op.extra?.(o) ?? [])], stdoutFile: tmp, timeoutMs: 20 * 60_000, progressParser, maxOutputBytes: 2_000_000 });
    // rename the result file once the job id is known
    const dest = this.resultPath(meta.id);
    const j = this.jobs.get(meta.id)!;
    const unsub = this.jobs.subscribe(meta.id, (l) => { if ("end" in l) { try { if (fs.existsSync(tmp)) fs.renameSync(tmp, dest); } catch { /* ignore */ } unsub(); } });
    void j;
    return meta;
  }

  /** Parse the real REA result (refuses absurdly large files rather than exhausting memory). */
  result(jobId: string): ReaEnvelope | null {
    const p = this.resultPath(jobId);
    if (!fs.existsSync(p)) return null;
    if (fs.statSync(p).size > 400_000_000) throw new Error("REA result is larger than 400 MB; use `rea inspect-analysis-view` to page it.");
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }
}

/* ---------------- evidence → OmniForge ---------------- */

export interface ReaEnvelope { evidence_id: string; subject: { name: string; digest?: { sha256?: string }; local_path?: string; format?: string }; provider: { id: string; name: string; version: string }; operation: string; predicate_type: string; normalized_result?: any; confidence: string; authority: string; limitations: string[]; locations?: unknown[] }

const CONF: Record<string, number> = { exact: 1, derived: 0.85, high: 0.9, medium: 0.6, low: 0.35 };

export function reaSummary(env: ReaEnvelope) {
  const n = env.normalized_result ?? {};
  return { operation: env.operation, evidenceId: env.evidence_id, subject: env.subject, provider: env.provider, confidence: env.confidence, authority: env.authority, summary: n.summary ?? null, statistics: n.statistics ?? null, graph: n.graph ? { nodes: n.graph.nodes?.length ?? 0, edges: n.graph.edges?.length ?? 0, coverage: n.graph.coverage?.status } : null, limitations: env.limitations ?? [] };
}

const nodeLabel = (n: any): string => n.observations?.[0]?.label ?? n.identity?.key ?? n.kind;
const nodeProps = (n: any): any => n.observations?.[0]?.properties ?? {};
const TYPE: Record<string, GraphNode["type"]> = { "browser-window": "service", "electron-main": "service", "electron-preload": "service", "electron-renderer": "service", "context-bridge-api": "service", "ipc-channel": "endpoint", "ipc-handler": "endpoint", endpoint: "endpoint", "javascript-module": "module", package: "module", artifact: "file", "javascript-asset": "file", "javascript-expression": "module" };
const REL: Record<string, Graph["edges"][number]["type"]> = { contains: "contains", imports: "imports", loads: "loads", calls: "calls", invokes: "calls", sends: "calls", handles: "calls", exposes: "implements", maps_to: "uses" };

/** Faithful mapping of a REA evidence envelope into an Investigation (provenance preserved on every record). */
export function reaToInvestigation(env: ReaEnvelope, o: { name?: string; targetPath?: string } = {}): Investigation {
  const startedAt = now();
  const n = env.normalized_result ?? {};
  const graph = n.graph ?? { nodes: [], edges: [] };
  const evidence: Evidence[] = [];
  const ev = (e: Omit<Evidence, "id" | "timestamp" | "method"> & { method?: string }) => { const id = uid("ev"); evidence.push({ id, timestamp: startedAt, method: e.method ?? `rea:${env.operation}`, ...e }); return id; };
  const rootEv = ev({ kind: "reconstructed", source: o.targetPath ?? env.subject?.local_path ?? env.subject?.name, hash: env.subject?.digest?.sha256, confidence: CONF[env.confidence] ?? 0.8, summary: `REA ${env.provider?.name} ${env.provider?.version} · ${env.operation} · authority “${env.authority}”, confidence “${env.confidence}” (evidence ${env.evidence_id})` });

  const nodes: GraphNode[] = [];
  const idMap = new Map<string, string>();
  for (const gn of (graph.nodes ?? []).slice(0, 1500)) {
    const id = `rea:${hashStr(gn.node_id).slice(0, 12)}`;
    idMap.set(gn.node_id, id);
    nodes.push({ id, type: TYPE[gn.kind] ?? "module", label: String(nodeLabel(gn)).slice(0, 80), data: { reaKind: gn.kind, ...(nodeProps(gn).members ? { members: nodeProps(gn).members } : {}) } });
  }
  const edges: Graph["edges"] = [];
  for (const e of (graph.edges ?? []).slice(0, 4000)) {
    const s = idMap.get(e.source_node_id), t = idMap.get(e.target_node_id);
    if (s && t) edges.push({ id: `e:${hashStr(e.source_node_id + e.target_node_id + e.relation).slice(0, 12)}`, source: s, target: t, type: REL[e.relation] ?? "uses" });
  }

  const byKind = (k: string) => (graph.nodes ?? []).filter((x: any) => x.kind === k);
  const features: Feature[] = [];
  const addF = (name: string, category: string, description: string, specExtra: Partial<Feature["spec"]>, evIds: string[]) => features.push({ id: `ft_${hashStr(name).slice(0, 10)}`, name, category, description, pages: [], files: [], evidence: evIds, confidence: 0.9, provenance: "reconstructed", spec: { purpose: description, inputs: [], outputs: [], states: ["Unknown: runtime behaviour not observed (static analysis only)"], transitions: [], dependencies: [], errorStates: ["Unknown"], accessibility: [], hypotheses: [], ...specExtra } });
  const channels = byKind("ipc-channel");
  if (channels.length) {
    const handlers = byKind("ipc-handler");
    addF("Electron IPC bridge", "Architecture", `${channels.length} IPC channel(s), ${handlers.length} main-process handler(s)`, {
      inputs: channels.map((c: any) => `${nodeProps(c).side ?? "?"} → ${nodeLabel(c)} (${nodeProps(c).operation ?? "?"})`),
      outputs: handlers.map((h: any) => `main handles “${nodeLabel(h)}” via ${nodeProps(h).operation}`),
      transitions: channels.map((c: any) => `renderer ${nodeProps(c).operation ?? "send"} ${nodeLabel(c)} → main`),
    }, [ev({ kind: "reconstructed", source: o.targetPath ?? "", confidence: 1, summary: `IPC channels: ${channels.map((c: any) => nodeLabel(c)).join(", ")}`, related: [rootEv] })]);
  }
  const bridges = byKind("context-bridge-api");
  if (bridges.length) addF("Renderer-exposed API (contextBridge)", "Architecture", bridges.map((b: any) => `window.${nodeLabel(b)}`).join(", "), { outputs: bridges.flatMap((b: any) => (nodeProps(b).members ?? []).map((m: string) => `window.${nodeLabel(b)}.${m}()`)) }, [ev({ kind: "reconstructed", source: o.targetPath ?? "", confidence: 1, summary: `contextBridge APIs: ${bridges.map((b: any) => `${nodeLabel(b)}{${(nodeProps(b).members ?? []).join(",")}}`).join("; ")}`, related: [rootEv] })]);
  const windows = byKind("browser-window");
  if (windows.length) addF("Application windows", "UI", `${windows.length} BrowserWindow(s)`, { inputs: windows.map((w: any) => `${nodeLabel(w)} ${JSON.stringify((nodeProps(w).web_preferences ?? []).reduce((a: any, p: any) => ({ ...a, [p.name]: p.value?.value }), {}))}`) }, [ev({ kind: "reconstructed", source: o.targetPath ?? "", confidence: 1, summary: `${windows.length} BrowserWindow constructor(s) with webPreferences recovered`, related: [rootEv] })]);

  const findings: Finding[] = [];
  const fnd = (sev: Finding["severity"], title: string, detail: string) => findings.push({ id: uid("fd"), area: "security", severity: sev, title, detail, evidence: [ev({ kind: "reconstructed", source: o.targetPath ?? "", confidence: 0.9, summary: title, related: [rootEv] })] });
  for (const w of windows) {
    const prefs: Record<string, unknown> = Object.fromEntries((nodeProps(w).web_preferences ?? []).map((p: any) => [p.name, p.value?.value]));
    if (prefs.nodeIntegration === true) fnd("high", "nodeIntegration is enabled for a renderer", "Renderer code can use Node.js APIs; any XSS becomes code execution. (static: webPreferences literal)");
    if (prefs.contextIsolation === false) fnd("high", "contextIsolation is disabled", "Preload and page share one JavaScript world.");
    if (prefs.sandbox === false) fnd("medium", "Renderer sandbox is disabled", "webPreferences.sandbox is false.");
  }
  if ((n.summary?.ipc?.main_handlers ?? 0) > 0 && (n.summary?.sender_validation_observations ?? 0) === 0) fnd("info", "No IPC sender validation observed", "Static analysis found no senderFrame/origin checks in IPC handlers. Absence in static analysis does not prove absence at runtime.");

  const endpoints = byKind("endpoint").map((e: any) => ({ url: String(nodeProps(e).value ?? nodeLabel(e)), kind: "rest" as const, foundIn: String(e.observations?.[0]?.evidence?.location?.value?.source ?? ""), evidence: rootEv }));
  const cov = graph.coverage?.status;
  const limitations = [...(env.limitations ?? []), ...(n.limitations ?? [])];
  const checks = [
    { id: "rea", label: `REA ${env.operation}`, status: (cov === "complete" ? "done" : "partial") as "done" | "partial", detail: `Graph coverage: ${cov ?? "n/a"}; ${n.statistics?.parsed_javascript_files ?? "?"} JS file(s) parsed, ${n.statistics?.parse_failures ?? 0} failure(s)` },
    { id: "runtime", label: "Runtime behaviour observed", status: "skipped" as const, detail: "Static analysis of the shipped artifact only" },
    { id: "server", label: "Server-side logic", status: "unavailable" as const, detail: "Not visible in a client application" },
  ];
  const appl = checks.filter((c) => c.status !== "unavailable");
  return {
    id: uid("inv"), name: o.name ?? env.subject?.name ?? "REA analysis", targets: [{ id: uid("tg"), kind: "package", value: o.targetPath ?? env.subject?.name ?? "", addedAt: startedAt }],
    config: { ...DEFAULT_CRAWL, mode: "single", fetchAssets: false }, status: "done", startedAt, finishedAt: now(), progress: 1, pages: [], assets: [],
    technologies: [{ name: "REA", category: "Analysis engine", version: env.provider?.version, confidence: 1, evidence: [rootEv] }, ...(windows.length ? [{ name: "Electron", category: "Desktop framework", confidence: 0.95, evidence: [rootEv] }] : [])],
    files: [], dependencies: [], endpoints, features, findings, evidence, graph: { nodes, edges }, coverage: { score: appl.reduce((a, c) => a + (c.status === "done" ? 1 : c.status === "partial" ? 0.5 : 0), 0) / appl.length, checks },
    limitations, questions: ["Dynamic behaviour (what actually runs and when) needs runtime observation; REA's runtime capture tools launch the app and require separate authorisation."], log: [{ t: now(), level: "info", msg: `Imported REA evidence ${env.evidence_id} (${env.operation})` }],
    components: [], routes: [], envVars: [],
  };
}
