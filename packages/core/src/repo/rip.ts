/**
 * Repo Rip: fetch → analyse → (exact clone | port to any app type | mesh several repos).
 * Everything deterministic is here and tested; only the porting itself is delegated to agents.
 */
import { intersects, validRange, minVersion, gt } from "semver";
import { strToU8, zipSync } from "fflate";
import { readArchive, safeEntryPath, stripCommonRoot } from "../analyze/archive.js";
import { analyzeSourceTree, type InputFile, type SourceTreeAnalysis } from "../analyze/source.js";
import { safeFetch, type FetchLike } from "../net/fetch.js";
import { BlockedUrlError } from "../net/ssrf.js";
import { task } from "../ai/agents.js";
import { stackById } from "../ai/plans.js";
import { untrusted } from "../ai/untrusted.js";
import type { AgentTask } from "../schema.js";
import { now } from "../util/index.js";
import { assertCanRip, assessRip, detectLicense, effective, type Assessment, type LicenseInfo } from "./license.js";
import type { RepoRef } from "./ref.js";

export interface RepoSnapshot {
  ref: RepoRef;
  sha?: string;
  defaultBranch?: string;
  description?: string;
  stars?: number;
  isPrivate?: boolean;
  files: InputFile[];
  skipped: { path: string; reason: string }[];
  licenses: LicenseInfo[];
  analysis?: SourceTreeAnalysis;
  fetchedAt: string;
  method: "tarball" | "git" | "upload";
}

const IGNORE_DIR = /(?:^|\/)(?:\.git|node_modules|\.next|\.nuxt|\.svelte-kit|\.turbo|\.vercel|dist|build|out|target|__pycache__|\.venv|venv|\.gradle|\.idea|\.vscode|coverage|\.pytest_cache|Pods|DerivedData)(?:\/|$)/;
const IGNORE_FILE = /(?:^|\/)(?:\.DS_Store|Thumbs\.db)$/;

export interface FilterOptions { subdir?: string; maxFiles?: number; maxFileBytes?: number; includeIgnored?: boolean }

export function filterFiles(entries: InputFile[], o: FilterOptions = {}): { kept: InputFile[]; skipped: { path: string; reason: string }[] } {
  const kept: InputFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const prefix = o.subdir ? o.subdir.replace(/^\/|\/$/g, "") + "/" : "";
  for (const e of entries) {
    if (prefix && !e.path.startsWith(prefix)) continue;
    const path = prefix ? e.path.slice(prefix.length) : e.path;
    if (!safeEntryPath(path)) { skipped.push({ path: e.path, reason: "unsafe path" }); continue; }
    if (!o.includeIgnored && (IGNORE_DIR.test(path) || IGNORE_FILE.test(path))) { skipped.push({ path, reason: "build/vendor/VCS directory" }); continue; }
    if (e.data.byteLength > (o.maxFileBytes ?? 8_000_000)) { skipped.push({ path, reason: `larger than ${(o.maxFileBytes ?? 8_000_000) / 1e6} MB` }); continue; }
    if (kept.length >= (o.maxFiles ?? 10_000)) { skipped.push({ path, reason: "file-count limit reached" }); continue; }
    kept.push({ ...e, path });
  }
  return { kept, skipped };
}

export async function snapshotFromFiles(ref: RepoRef, files: InputFile[], meta: Partial<RepoSnapshot> & { method: RepoSnapshot["method"] }, f: FilterOptions = {}): Promise<RepoSnapshot> {
  const { kept, skipped } = filterFiles(files, { subdir: ref.subdir, ...f });
  const text = kept.filter((k) => /(?:^|\/)(?:LICEN[CS]E|COPYING|UNLICENSE)|(?:^|\/)(?:package\.json|Cargo\.toml|pyproject\.toml)$/i.test(k.path) && k.data.byteLength < 200_000).map((k) => ({ path: k.path, content: new TextDecoder().decode(k.data) }));
  const licenses = detectLicense(text, { spdx: (meta as { licenseHint?: string }).licenseHint });
  return { fetchedAt: now(), ...meta, ref, files: kept, skipped, licenses };
}

export async function analyzeSnapshot(s: RepoSnapshot): Promise<RepoSnapshot> {
  s.analysis = await analyzeSourceTree(s.files.map((f) => ({ ...f, origin: `${s.ref.webUrl}${s.sha ? `@${s.sha.slice(0, 7)}` : ""}`, provenance: "recovered" as const })), { includeContent: false });
  return s;
}

/* ---------------- tarball fetch (hosted web) ---------------- */

const ALLOWED_HOSTS = new Set(["github.com", "api.github.com", "codeload.github.com", "gitlab.com", "objects.githubusercontent.com"]);

export interface FetchRepoOptions { token?: string; fetch?: FetchLike; maxBytes?: number; signal?: AbortSignal; baseUrls?: { api?: string; codeload?: string; gitlab?: string }; filter?: FilterOptions; allowAnyHost?: boolean; resolver?: (h: string) => Promise<string[]> }

export async function fetchRepoSnapshot(ref: RepoRef, o: FetchRepoOptions = {}): Promise<RepoSnapshot> {
  if (ref.host === "other") throw new Error("Only GitHub and GitLab can be fetched without git. Use the desktop app (git clone) for other hosts.");
  const api = o.baseUrls?.api ?? "https://api.github.com";
  const codeload = o.baseUrls?.codeload ?? "https://codeload.github.com";
  const gitlab = o.baseUrls?.gitlab ?? "https://gitlab.com";
  const guard = (u: URL) => { if (!o.allowAnyHost && !ALLOWED_HOSTS.has(u.hostname)) throw new BlockedUrlError(`Redirected to an unexpected host: ${u.hostname}`, "scope"); };
  const headers: Record<string, string> = { "user-agent": "OmniForgeRE", accept: "application/vnd.github+json" };
  if (o.token && ref.host === "github") headers.authorization = `Bearer ${o.token}`;

  let meta: Partial<RepoSnapshot> & { licenseHint?: string } = {};
  if (ref.host === "github") {
    try {
      const m = await safeFetch(`${api}/repos/${ref.owner}/${ref.repo}`, { fetch: o.fetch, headers, maxBytes: 500_000, signal: o.signal, beforeHop: guard, allowPrivate: o.allowAnyHost, resolver: o.resolver });
      if (m.status === 200) {
        const j = JSON.parse(m.text());
        meta = { defaultBranch: j.default_branch, description: j.description ?? undefined, stars: j.stargazers_count, isPrivate: j.private, licenseHint: j.license?.spdx_id };
      } else if (m.status === 404) throw new Error(o.token ? "Repository not found, or your token cannot access it." : "Repository not found. If it is private, add a GitHub token in Integrations.");
      else if (m.status === 403 && /rate limit/i.test(m.text())) meta = {}; // metadata is optional; continue
    } catch (e) {
      if (/not found/i.test((e as Error).message)) throw e;
    }
  }
  const refName = ref.ref ?? meta.defaultBranch ?? "HEAD";
  const url = ref.host === "github"
    ? o.token ? `${api}/repos/${ref.owner}/${ref.repo}/tarball/${encodeURIComponent(refName)}` : `${codeload}/${ref.owner}/${ref.repo}/tar.gz/${refName === "HEAD" ? "HEAD" : refName}`
    : `${gitlab}/${ref.owner}/${ref.repo}/-/archive/${refName === "HEAD" ? "HEAD" : refName}/${ref.repo}-${refName}.tar.gz`;
  const res = await safeFetch(url, { fetch: o.fetch, headers: { ...headers, accept: "*/*" }, maxBytes: o.maxBytes ?? 120_000_000, timeoutMs: 120_000, signal: o.signal, beforeHop: guard, allowPrivate: o.allowAnyHost, resolver: o.resolver } as never);
  if (res.status === 404) throw new Error("Repository or ref not found (or it is private and no token was supplied).");
  if (res.status !== 200) throw new Error(`Repository download failed: HTTP ${res.status}`);
  if (res.truncated) throw new Error("Repository archive is larger than the download limit; use a subdirectory URL or the desktop app (git clone).");
  const arch = readArchive(res.body, "repo.tar.gz", { maxTotalBytes: 400_000_000, maxEntryBytes: 30_000_000, maxEntries: 60_000 });
  const rootName = arch.entries[0]?.path.split("/")[0] ?? "";
  const entries = stripCommonRoot(arch.entries);
  const shaMatch = rootName.match(/-([0-9a-f]{7,40})$/);
  const snap = await snapshotFromFiles(ref, entries.map((e) => ({ path: e.path, data: e.data })), { ...meta, sha: shaMatch?.[1], method: "tarball" }, o.filter);
  snap.skipped.push(...arch.skipped.map((s) => ({ path: s.split(" (")[0]!, reason: s })));
  return snap;
}

/* ---------------- exact clone ---------------- */

export function attributionMarkdown(snaps: RepoSnapshot[], a: Assessment, purpose: string): string {
  const rows = snaps.map((s) => {
    const l = effective(s.licenses);
    return `### ${s.ref.owner}/${s.ref.repo}\n- Source: ${s.ref.webUrl}${s.ref.subdir ? ` (subdirectory \`${s.ref.subdir}\`)` : ""}\n- Revision: ${s.sha ?? s.ref.ref ?? "default branch at time of copy"}\n- Licence: **${l.spdx}** (${l.class}; detected from ${l.source})\n- Retrieved: ${s.fetchedAt}\n- Obligations: ${a.perRepo.find((p) => p.repo === `${s.ref.owner}/${s.ref.repo}`)?.obligations.join(" ") ?? ""}\n`;
  });
  return `# Attribution\n\nThis project (${purpose}) incorporates or is derived from the following open-source repositories. Their original licence texts are preserved under \`licenses/\`.\n\n${rows.join("\n")}\n${a.conflicts.length ? `## Licence conflicts to resolve\n${a.conflicts.map((c) => `- ${c}`).join("\n")}\n\n` : ""}${a.messages.length ? `## Notes\n${a.messages.map((m) => `- ${m}`).join("\n")}\n` : ""}\n_Generated by OmniForge RE. This is not legal advice._\n`;
}

export function licenseFilesOf(s: RepoSnapshot): { path: string; data: Uint8Array }[] {
  return s.files.filter((f) => /^(?:LICEN[CS]E|COPYING|UNLICENSE|NOTICE)(?:[-.][\w.-]+)?$/i.test(f.path)).map((f) => ({ path: f.path, data: f.data }));
}

export interface ClonePackage { files: Map<string, Uint8Array>; textFiles: Record<string, string>; binaries: { path: string; bytes: number }[]; assessment: Assessment; notes: string[] }

/** The literal copy: every file byte-for-byte + attribution. `textFiles` is what the in-app workspace/editor can hold. */
export function buildClonePackage(snap: RepoSnapshot, assessment: Assessment, o: { prefix?: string; attested?: boolean } = {}): ClonePackage {
  assertCanRip(assessment, !!o.attested); // rights checkpoint: unlicensed/proprietary code needs an explicit attestation
  const prefix = o.prefix ? o.prefix.replace(/\/?$/, "/") : "";
  const files = new Map<string, Uint8Array>();
  const textFiles: Record<string, string> = {};
  const binaries: { path: string; bytes: number }[] = [];
  const dec = new TextDecoder("utf-8", { fatal: true });
  for (const f of snap.files) {
    files.set(prefix + f.path, f.data);
    try {
      if (f.data.byteLength > 1_500_000) throw new Error("big");
      textFiles[prefix + f.path] = dec.decode(f.data);
    } catch {
      binaries.push({ path: prefix + f.path, bytes: f.data.byteLength });
    }
  }
  const attr = attributionMarkdown([snap], assessment, "an exact copy");
  files.set(prefix + "ATTRIBUTION.md", strToU8(attr));
  textFiles[prefix + "ATTRIBUTION.md"] = attr;
  return { files, textFiles, binaries, assessment, notes: [...(binaries.length ? [`${binaries.length} binary file(s) are in the ZIP/GitHub copy but not shown in the editor.`] : []), ...(snap.skipped.length ? [`${snap.skipped.length} file(s) skipped (${[...new Set(snap.skipped.map((s) => s.reason.split(" (")[0]))].slice(0, 3).join("; ")}).`] : [])] };
}

export function zipPackage(files: Map<string, Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(files), { level: 6 });
}

/* ---------------- mesh (side-by-side monorepo) ---------------- */

export interface MeshOptions { name?: string; layout?: "packages" | "apps"; assignPorts?: boolean; basePort?: number; attested?: boolean }
export interface DepConflict { name: string; ranges: { repo: string; range: string }[]; compatible: boolean; suggestion: string }
export interface MeshReport {
  packages: { slug: string; dir: string; repo: string; buildSystems: string[]; frameworks: string[]; scripts: string[]; ecosystem: string }[];
  dependencyConflicts: DepConflict[];
  portAssignments: { slug: string; script: string; port: number; reason: string }[];
  nameCollisions: string[];
  notes: string[];
}

const slugOf = (s: RepoSnapshot, taken: Set<string>) => {
  let base = s.ref.repo.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (taken.has(base)) base = `${s.ref.owner}-${s.ref.repo}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  let n = 2, out = base;
  while (taken.has(out)) out = `${base}-${n++}`;
  taken.add(out);
  return out;
};

function readJson(s: RepoSnapshot, path: string): any | null {
  const f = s.files.find((x) => x.path === path);
  if (!f) return null;
  try { return JSON.parse(new TextDecoder().decode(f.data)); } catch { return null; }
}

const DEFAULT_PORT: [RegExp, number][] = [[/\bnext\b/, 3000], [/\bvite\b/, 5173], [/react-scripts/, 3000], [/\bnuxt\b/, 3000], [/\bastro\b/, 4321], [/\bsvelte-kit|vite dev/, 5173], [/\bremix\b/, 3000], [/webpack(?:-dev-server| serve)/, 8080], [/\bng serve\b/, 4200]];

export function meshRepos(snaps: RepoSnapshot[], assessment: Assessment, o: MeshOptions = {}): { files: Map<string, Uint8Array>; report: MeshReport } {
  assertCanRip(assessment, !!o.attested);
  const dir = o.layout ?? "packages";
  const name = (o.name ?? "mesh").toLowerCase().replace(/[^a-z0-9-]/g, "-") || "mesh";
  const files = new Map<string, Uint8Array>();
  const report: MeshReport = { packages: [], dependencyConflicts: [], portAssignments: [], nameCollisions: [], notes: [] };
  const taken = new Set<string>();
  const rootScripts: Record<string, string> = {};
  const depMap = new Map<string, { repo: string; range: string }[]>();
  const pkgNames = new Map<string, string[]>();
  const usedPorts = new Set<number>();
  let nextPort = o.basePort ?? 3100;

  for (const s of snaps) {
    const slug = slugOf(s, taken);
    const pdir = `${dir}/${slug}`;
    const pkg = readJson(s, "package.json");
    const rewritten = new Map<string, Uint8Array>();
    const scripts: string[] = [];
    if (pkg) {
      if (pkg.name) pkgNames.set(pkg.name, [...(pkgNames.get(pkg.name) ?? []), slug]);
      for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const)
        for (const [dep, range] of Object.entries<string>(pkg[k] ?? {})) depMap.set(dep, [...(depMap.get(dep) ?? []), { repo: slug, range: String(range) }]);
      for (const [sn, cmd] of Object.entries<string>(pkg.scripts ?? {})) {
        scripts.push(sn);
        if (["dev", "start", "build", "test", "lint"].includes(sn)) rootScripts[`${sn}:${slug}`] = `npm run ${sn} --workspace ${pdir}`;
      }
      // dev-server port collisions
      if (o.assignPorts !== false && pkg.scripts?.dev) {
        const cmd: string = pkg.scripts.dev;
        const explicit = cmd.match(/(?:-p|--port)[ =](\d{2,5})/)?.[1] ?? cmd.match(/\bPORT=(\d{2,5})/)?.[1];
        let port = explicit ? Number(explicit) : DEFAULT_PORT.find(([re]) => re.test(cmd))?.[1];
        if (port !== undefined && usedPorts.has(port)) {
          while (usedPorts.has(nextPort)) nextPort++;
          const newPort = nextPort++;
          const isNext = /\bnext\b/.test(cmd), isVite = /\bvite\b/.test(cmd) && !isNext;
          if (isNext || isVite) {
            const patched = explicit ? cmd.replace(/(-p|--port)([ =])\d{2,5}/, `$1$2${newPort}`) : `${cmd} ${isNext ? "-p" : "--port"} ${newPort}`;
            const p2 = { ...pkg, scripts: { ...pkg.scripts, dev: patched } };
            rewritten.set("package.json", strToU8(JSON.stringify(p2, null, 2) + "\n"));
            report.portAssignments.push({ slug, script: "dev", port: newPort, reason: `default/declared port ${port} was already used by another package` });
            port = newPort;
          } else report.notes.push(`${slug}: dev server port ${port} collides with another package; set its port manually (script: ${cmd}).`);
        }
        if (port !== undefined) usedPorts.add(port);
      }
    }
    for (const f of s.files) files.set(`${pdir}/${f.path}`, rewritten.get(f.path) ?? f.data);
    const a = s.analysis;
    report.packages.push({ slug, dir: pdir, repo: `${s.ref.owner}/${s.ref.repo}`, buildSystems: a?.buildSystems ?? [], frameworks: a?.frameworks ?? [], scripts, ecosystem: pkg ? "node" : a?.buildSystems.find((b) => /cargo|go|pip|poetry|maven|gradle|dotnet|composer|bundler/.test(b)) ?? "other" });
  }

  for (const [n, slugs] of pkgNames) if (slugs.length > 1) report.nameCollisions.push(`package name “${n}” is declared by ${slugs.join(" and ")}; npm workspaces need unique names — rename one.`);
  for (const [dep, ranges] of depMap) {
    const distinct = [...new Map(ranges.map((r) => [`${r.repo}`, r])).values()];
    const uniqueRanges = [...new Set(distinct.map((r) => r.range))];
    if (distinct.length < 2 || uniqueRanges.length < 2) continue;
    const valid = uniqueRanges.filter((r) => validRange(r));
    let compatible = valid.length === uniqueRanges.length;
    for (let i = 0; compatible && i < valid.length; i++) for (let j = i + 1; j < valid.length; j++) if (!intersects(valid[i]!, valid[j]!)) { compatible = false; break; }
    let suggestion = "Each package keeps its own copy under npm workspaces; no action required unless you dedupe.";
    if (compatible) {
      const best = valid.map((r) => { try { return minVersion(r)!; } catch { return null; } }).filter(Boolean).reduce((a, b) => (gt(a!, b!) ? a : b));
      suggestion = `Ranges overlap; a single hoisted version (≥ ${best!.version}) can serve all packages.`;
    } else suggestion = "Ranges do not overlap (major-version split). Keep them isolated per package, or upgrade the older one before sharing the dependency.";
    report.dependencyConflicts.push({ name: dep, ranges: distinct, compatible, suggestion });
  }
  report.dependencyConflicts.sort((a, b) => Number(a.compatible) - Number(b.compatible) || a.name.localeCompare(b.name));

  const nodePkgs = report.packages.filter((p) => p.ecosystem === "node");
  const rootPkg = {
    name,
    private: true,
    version: "0.0.0",
    description: `Meshed monorepo of ${snaps.map((s) => `${s.ref.owner}/${s.ref.repo}`).join(", ")}`,
    workspaces: nodePkgs.map((p) => p.dir),
    scripts: { ...rootScripts, build: "npm run build --workspaces --if-present", test: "npm run test --workspaces --if-present", lint: "npm run lint --workspaces --if-present" },
  };
  files.set("package.json", strToU8(JSON.stringify(rootPkg, null, 2) + "\n"));
  files.set(".gitignore", strToU8("node_modules\n.next\ndist\nbuild\n.env\n.env.*\n!.env.example\n__pycache__\ntarget\n"));
  const readme = `# ${name}\n\nA monorepo meshed from ${snaps.length} repositories, each kept intact in its own directory so every app still runs as its authors intended.\n\n## Packages\n${report.packages.map((p) => `- \`${p.dir}\` — ${p.repo} (${p.ecosystem}${p.frameworks.length ? `, ${p.frameworks.join("/")}` : ""})${p.ecosystem === "node" ? `\n  - run: \`npm run dev:${p.slug}\` · build: \`npm run build:${p.slug}\`` : `\n  - non-Node project: follow its own README (${p.buildSystems.join(", ") || "see directory"})`}`).join("\n")}\n\n## Getting started\n\`\`\`bash\nnpm install   # installs every Node package via workspaces\nnpm run build # builds all Node packages\n\`\`\`\n${report.portAssignments.length ? `\n## Ports\n${report.portAssignments.map((p) => `- ${p.slug}: dev server moved to ${p.port} (${p.reason})`).join("\n")}\n` : ""}${report.dependencyConflicts.length ? `\n## Dependency overlaps\n${report.dependencyConflicts.slice(0, 15).map((d) => `- **${d.name}**: ${d.ranges.map((r) => `${r.repo}@${r.range}`).join(", ")} — ${d.compatible ? "compatible" : "CONFLICT"}`).join("\n")}\n` : ""}\nSee ATTRIBUTION.md for sources and licences.\n`;
  files.set("README.md", strToU8(readme));
  files.set("ATTRIBUTION.md", strToU8(attributionMarkdown(snaps, assessment, "a meshed monorepo")));
  snaps.forEach((s, i) => { for (const l of licenseFilesOf(s)) files.set(`licenses/${report.packages[i]!.slug}/${l.path}`, l.data); });
  if (assessment.conflicts.length) report.notes.push(...assessment.conflicts);
  files.set("MESH_REPORT.json", strToU8(JSON.stringify(report, null, 2)));
  return { files, report };
}

/* ---------------- AI plans: port / integrated mesh ---------------- */

export interface Batch { name: string; files: string[]; bytes: number }

/** Group a repo's text source into porting batches by top-level module, bounded by size. */
export function partitionBatches(s: RepoSnapshot, o: { maxBatchBytes?: number; maxBatches?: number } = {}): { batches: Batch[]; omitted: number } {
  const maxB = o.maxBatchBytes ?? 40_000;
  const code = s.files.filter((f) => /\.(?:[cm]?[jt]sx?|vue|svelte|astro|py|rs|go|java|kt|swift|rb|php|cs|cpp|cc|c|h|hpp|css|scss|html|sql|graphql|prisma)$/i.test(f.path) && !/\.(?:test|spec)\./.test(f.path) && f.data.byteLength < 200_000);
  const byDir = new Map<string, InputFile[]>();
  for (const f of code) {
    const parts = f.path.split("/");
    const key = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length > 1 ? parts[0]! : "(root)";
    byDir.set(key, [...(byDir.get(key) ?? []), f]);
  }
  const batches: Batch[] = [];
  for (const [dir, fs] of [...byDir].sort((a, b) => a[0].localeCompare(b[0]))) {
    let cur: Batch = { name: dir, files: [], bytes: 0 };
    for (const f of fs.sort((a, b) => a.path.localeCompare(b.path))) {
      if (cur.bytes + f.data.byteLength > maxB && cur.files.length) { batches.push(cur); cur = { name: `${dir} (cont.)`, files: [], bytes: 0 }; }
      cur.files.push(f.path);
      cur.bytes += f.data.byteLength;
    }
    if (cur.files.length) batches.push(cur);
  }
  const cap = o.maxBatches ?? 30;
  const kept = batches.slice(0, cap);
  return { batches: kept, omitted: batches.slice(cap).reduce((n, b) => n + b.files.length, 0) };
}

const fileBlock = (s: RepoSnapshot, paths: string[]) => paths.map((p) => `--- ${p}\n${new TextDecoder().decode(s.files.find((f) => f.path === p)!.data)}`).join("\n\n");

export interface PortOptions { targetStackId: string; note?: string; mode?: "port" | "copy-and-adapt" }

export function buildPortPlan(s: RepoSnapshot, o: PortOptions): { tasks: AgentTask[]; omitted: number; batches: Batch[] } {
  const target = stackById(o.targetStackId);
  const a = s.analysis;
  const { batches, omitted } = partitionBatches(s);
  const repo = `${s.ref.owner}/${s.ref.repo}`;
  const overview = untrusted(`repo:${repo}`, [
    `Repository ${repo} (${effective(s.licenses).spdx})`, s.description ? `Description: ${s.description}` : "",
    a ? `Languages: ${a.languages.slice(0, 6).map((l) => `${l.language} ${l.lines}L`).join(", ")}\nFrameworks: ${a.frameworks.join(", ") || "none detected"}\nBuild: ${a.buildSystems.join(", ")}\nEntrypoints: ${a.entrypoints.slice(0, 15).join(", ")}\nRoutes: ${a.routes.slice(0, 40).map((r) => r.route).join(", ")}\nComponents: ${a.components.slice(0, 40).map((c) => c.name).join(", ")}\nDatabase: ${a.databaseDefinitions.map((d) => `${d.kind}:${d.path}`).join(", ")}\nEnv vars (names): ${a.envVars.map((e) => e.name).join(", ")}\nDependencies: ${a.dependencies.filter((d) => !d.dev).slice(0, 60).map((d) => `${d.name}@${d.version ?? "?"}`).join(", ")}` : "",
    `File tree (${s.files.length} files):\n${s.files.map((f) => f.path).slice(0, 400).join("\n")}`,
  ].filter(Boolean).join("\n"), 30_000);
  const mapT = task({ role: "architecture", objective: `Study ${repo} and write PORT_MAP.md: for each module/batch, name the equivalent in ${target.label} (${target.hint}), note framework-specific features that need different solutions, and list the shared types/utilities to create first.${o.note ? `\nUser goal: ${o.note}` : ""}`, inputs: [overview], acceptance: ["file_exists:PORT_MAP.md"] });
  const scaffold = task({ role: "development", objective: `Create the ${target.label} project scaffold (${target.files.join(", ") || "as needed"}), README.md, .env.example (names only) and shared types/utilities per PORT_MAP.md.`, dependsOn: [mapT.id], acceptance: target.files.map((f) => `file_exists:${f}`) });
  const ports = batches.map((b, i) => task({
    role: "development",
    objective: `Port batch ${i + 1}/${batches.length} “${b.name}” (${b.files.length} files) from ${repo} to ${target.label}, following PORT_MAP.md. Preserve behaviour; write complete files.${o.mode === "copy-and-adapt" ? " Keep the original structure and naming wherever the target allows." : ""}`,
    dependsOn: [scaffold.id], inputs: [untrusted(`source:${b.name}`, fileBlock(s, b.files), 80_000)],
  }));
  const tests = task({ role: "testing", objective: `Write and run tests for the ported code${target.test ? ` (\`${target.test}\`)` : ""}; compare behaviour with the original where the source tests are available.`, dependsOn: ports.length ? ports.map((p) => p.id) : [scaffold.id], acceptance: target.test ? [`run:${target.test}`] : [] });
  const review = task({ role: "review", objective: `Review the port against ${repo}: missing features, behavioural differences, security issues. List concrete gaps, including the ${omitted} source file(s) not ported (if any).`, dependsOn: [tests.id] });
  const fix = task({ role: "development", objective: "Fix the gaps and failing tests found; re-run checks.", dependsOn: [review.id], acceptance: target.test ? [`run:${target.test}`] : [] });
  return { tasks: [mapT, scaffold, ...ports, tests, review, fix], omitted, batches };
}

export function buildMeshPlan(snaps: RepoSnapshot[], o: { goal: string; targetStackId: string }): AgentTask[] {
  const target = stackById(o.targetStackId);
  const analyses = snaps.map((s) => task({
    role: "reverse", objective: `Analyse ${s.ref.owner}/${s.ref.repo}: its purpose, features, data model, APIs and extension points. Write ANALYSIS_${s.ref.repo}.md.`,
    inputs: [untrusted(`repo:${s.ref.repo}`, `${s.analysis ? `Frameworks: ${s.analysis.frameworks.join(", ")}\nRoutes: ${s.analysis.routes.map((r) => r.route).join(", ")}\nComponents: ${s.analysis.components.slice(0, 50).map((c) => c.name).join(", ")}\n` : ""}Files:\n${s.files.map((f) => f.path).slice(0, 300).join("\n")}\n\nREADME:\n${new TextDecoder().decode(s.files.find((f) => /^README(\.md)?$/i.test(f.path))?.data ?? new Uint8Array()).slice(0, 6000)}`, 30_000)],
    acceptance: [`file_exists:ANALYSIS_${s.ref.repo}.md`],
  }));
  const plan = task({ role: "architecture", objective: `Design ONE integrated ${target.label} application that combines these repositories to achieve: ${o.goal}. Write MESH_PLAN.md: what comes from each repo, the unified data model and navigation, conflicts and how they are resolved, and the file layout.`, dependsOn: analyses.map((a) => a.id), acceptance: ["file_exists:MESH_PLAN.md"] });
  const scaffold = task({ role: "development", objective: `Scaffold the integrated ${target.label} app per MESH_PLAN.md.`, dependsOn: [plan.id], acceptance: target.files.map((f) => `file_exists:${f}`) });
  const impls = snaps.map((s, i) => task({ role: "development", objective: `Integrate the capabilities taken from ${s.ref.owner}/${s.ref.repo} into the app per MESH_PLAN.md (independent implementation unless the licence allows reuse).`, dependsOn: [scaffold.id], inputs: [`Source analysis: ANALYSIS_${s.ref.repo}.md`] }));
  const ui = task({ role: "uiux", objective: "Unify navigation and design across the integrated features; accessible, responsive.", dependsOn: impls.map((t) => t.id) });
  const tests = task({ role: "testing", objective: `Write and run tests for each integrated capability${target.test ? ` (\`${target.test}\`)` : ""}.`, dependsOn: [ui.id], acceptance: target.test ? [`run:${target.test}`] : [] });
  return [...analyses, plan, scaffold, ...impls, ui, tests, task({ role: "review", objective: "Review the integrated app for correctness, licence compliance and security.", dependsOn: [tests.id] })];
}
