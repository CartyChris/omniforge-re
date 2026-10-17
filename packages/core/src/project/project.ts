/**
 * Project persistence: the same on-disk/exported shape is used by the web app
 * (IndexedDB/server) and the macOS app (filesystem), so a project begun in one
 * continues in the other.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { ProjectFileSchema, SCHEMA_VERSION } from "../schema.js";
import type { Investigation, Project, Snapshot } from "../schema.js";
import { safeEntryPath } from "../analyze/archive.js";
import { now, uid } from "../util/index.js";

export class ProjectImportError extends Error {}

export function createProject(name: string, o: { description?: string; localOnly?: boolean } = {}): Project {
  const t = now();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uid("prj"),
    name: name.trim().slice(0, 120) || "Untitled project",
    description: o.description ?? "",
    createdAt: t,
    updatedAt: t,
    localOnly: o.localOnly ?? false,
    investigations: [],
    workspace: { files: {}, open: [] },
    snapshots: [],
    conversations: [],
    tasks: [],
    builds: [],
    deployments: [],
    featureLibrary: [],
  };
}

export const touch = <T extends Project>(p: T): T => ({ ...p, updatedAt: now() });

export function upsertInvestigation(p: Project, inv: Investigation): Project {
  const i = p.investigations.findIndex((x) => x.id === inv.id);
  const investigations = i >= 0 ? p.investigations.map((x, j) => (j === i ? inv : x)) : [...p.investigations, inv];
  return touch({ ...p, investigations });
}

export function writeFile(p: Project, path: string, content: string): Project {
  const safe = safeEntryPath(path);
  if (!safe) throw new Error(`Unsafe workspace path: ${path}`);
  return touch({ ...p, workspace: { ...p.workspace, files: { ...p.workspace.files, [safe]: content } } });
}

export function deleteFile(p: Project, path: string): Project {
  const files = { ...p.workspace.files };
  delete files[path];
  return touch({ ...p, workspace: { ...p.workspace, files, open: p.workspace.open.filter((x) => x !== path), active: p.workspace.active === path ? undefined : p.workspace.active } });
}

export function createSnapshot(p: Project, label: string): { project: Project; snapshot: Snapshot } {
  const snapshot: Snapshot = { id: uid("snap"), label: label.slice(0, 120), at: now(), files: { ...p.workspace.files } };
  return { project: touch({ ...p, snapshots: [snapshot, ...p.snapshots].slice(0, 50) }), snapshot };
}

/** Restoring first takes an automatic snapshot, so a restore is itself undoable. */
export function restoreSnapshot(p: Project, id: string): Project {
  const s = p.snapshots.find((x) => x.id === id);
  if (!s) throw new Error("Snapshot not found");
  const { project } = createSnapshot(p, `Auto-backup before restoring “${s.label}”`);
  return touch({ ...project, workspace: { ...project.workspace, files: { ...s.files }, open: project.workspace.open.filter((f) => f in s.files) } });
}

export function diffSnapshots(a: Record<string, string>, b: Record<string, string>) {
  const added = Object.keys(b).filter((k) => !(k in a));
  const removed = Object.keys(a).filter((k) => !(k in b));
  const changed = Object.keys(b).filter((k) => k in a && a[k] !== b[k]);
  return { added, removed, changed };
}

const LIMITS = { files: 5000, totalBytes: 100_000_000 };

/** Export as a ZIP: project.json (authoritative) + files/ for human access. */
export function exportProject(p: Project): Uint8Array {
  const out: Record<string, Uint8Array> = { "project.json": strToU8(JSON.stringify(p, null, 2)) };
  for (const [path, content] of Object.entries(p.workspace.files)) {
    const safe = safeEntryPath(path);
    if (safe) out[`files/${safe}`] = strToU8(content);
  }
  return zipSync(out, { level: 6 });
}

/** Import an untrusted project file (.zip export or raw project.json). */
export function importProject(input: Uint8Array | string): Project {
  let json: string;
  if (typeof input === "string") json = input;
  else if (input[0] === 0x50 && input[1] === 0x4b) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(input, { filter: (f) => f.name === "project.json" && f.originalSize < LIMITS.totalBytes });
    } catch (e) {
      throw new ProjectImportError(`Invalid project archive: ${(e as Error).message}`);
    }
    if (!entries["project.json"]) throw new ProjectImportError("Archive has no project.json");
    json = strFromU8(entries["project.json"]);
  } else json = strFromU8(input);
  if (json.length > LIMITS.totalBytes) throw new ProjectImportError("Project file too large");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new ProjectImportError(`Not valid JSON: ${(e as Error).message}`);
  }
  const parsed = ProjectFileSchema.safeParse(raw);
  if (!parsed.success) throw new ProjectImportError(`Not a valid OmniForge project: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const p = parsed.data as unknown as Project;
  // sanitise workspace paths: imported projects may be hostile
  const files: Record<string, string> = {};
  let n = 0;
  for (const [path, content] of Object.entries(p.workspace.files)) {
    const safe = safeEntryPath(path);
    if (!safe || ++n > LIMITS.files) continue;
    files[safe] = content;
  }
  return {
    ...p,
    id: p.id, // keep identity so re-import replaces rather than duplicates
    workspace: { ...p.workspace, files, open: p.workspace.open.filter((x) => x in files), active: p.workspace.active && p.workspace.active in files ? p.workspace.active : undefined },
    snapshots: (p.snapshots as Snapshot[]).map((s) => ({ ...s, files: Object.fromEntries(Object.entries(s.files ?? {}).flatMap(([k, v]) => { const sk = safeEntryPath(k); return sk ? [[sk, v]] : []; })) })),
  };
}

/** Which headline numbers a project card shows. */
export function projectStats(p: Project) {
  const inv = p.investigations;
  return {
    investigations: inv.length,
    pages: inv.reduce((n, i) => n + i.pages.length, 0),
    features: inv.reduce((n, i) => n + i.features.length, 0),
    files: Object.keys(p.workspace.files).length,
    snapshots: p.snapshots.length,
    deployments: p.deployments.length,
  };
}
