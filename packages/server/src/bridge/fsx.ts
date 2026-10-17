/**
 * Filesystem access limited to user-approved roots. Defends against `..`,
 * absolute paths and symlinks that point outside the root; never returns the
 * VALUES of .env files.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { dotenvNames, type InputFile } from "@omniforge/core";

export class FsError extends Error { constructor(public status: number, m: string) { super(m); } }

export interface Root { id: string; path: string; label: string; writable: boolean }

const IGNORE = new Set(["node_modules", ".git", ".next", ".nuxt", ".svelte-kit", ".turbo", ".vercel", "dist", "build", "out", "target", "__pycache__", ".venv", "venv", ".gradle", ".idea", "coverage", "Pods", "DerivedData", ".DS_Store"]);
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[\w.-]+)?|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.keystore|credentials\.json|\.npmrc|\.netrc)$/i;

export class Roots {
  private roots = new Map<string, Root>();
  async add(p: string, o: { label?: string; writable?: boolean } = {}): Promise<Root> {
    const real = await fs.realpath(path.resolve(p)).catch(() => { throw new FsError(404, `Folder not found: ${p}`); });
    const st = await fs.stat(real);
    if (!st.isDirectory()) throw new FsError(400, "Not a folder");
    if (real === path.parse(real).root || real === process.env.HOME) throw new FsError(400, "Choose a project folder, not the filesystem root or your whole home directory.");
    const id = Buffer.from(real).toString("base64url").slice(0, 16);
    const r: Root = { id, path: real, label: o.label ?? path.basename(real), writable: !!o.writable };
    this.roots.set(id, r);
    return r;
  }
  remove(id: string) { return this.roots.delete(id); }
  list() { return [...this.roots.values()]; }
  get(id: string): Root { const r = this.roots.get(id); if (!r) throw new FsError(403, "That folder has not been approved. Approve it in the desktop app."); return r; }

  /** Resolve a relative path inside a root; symlinks are resolved and re-checked. */
  async resolve(rootId: string, rel: string, o: { mustExist?: boolean } = {}): Promise<string> {
    const root = this.get(rootId);
    if (rel.includes("\0")) throw new FsError(400, "Invalid path");
    if (path.isAbsolute(rel)) throw new FsError(400, "Paths must be relative to the approved folder");
    const target = path.resolve(root.path, rel);
    const within = (p: string) => p === root.path || p.startsWith(root.path + path.sep);
    if (!within(target)) throw new FsError(403, "Path escapes the approved folder");
    let real: string;
    try { real = await fs.realpath(target); }
    catch {
      if (o.mustExist) throw new FsError(404, "Not found");
      const parent = await fs.realpath(path.dirname(target)).catch(() => root.path);
      real = path.join(parent, path.basename(target));
    }
    if (!within(real)) throw new FsError(403, "Path resolves outside the approved folder (symlink)");
    return real;
  }
}

export interface TreeEntry { path: string; type: "file" | "dir"; size?: number }

export async function listTree(roots: Roots, rootId: string, o: { max?: number; sub?: string } = {}): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const base = await roots.resolve(rootId, o.sub ?? ".", { mustExist: true });
  const rootPath = roots.get(rootId).path;
  const out: TreeEntry[] = [];
  const max = o.max ?? 5000;
  let truncated = false;
  async function walk(dir: string) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const it of items) {
      if (out.length >= max) { truncated = true; return; }
      if (IGNORE.has(it.name) || it.isSymbolicLink()) continue;
      const full = path.join(dir, it.name);
      const rel = path.relative(rootPath, full).split(path.sep).join("/");
      if (it.isDirectory()) { out.push({ path: rel, type: "dir" }); await walk(full); }
      else if (it.isFile()) out.push({ path: rel, type: "file", size: (await fs.stat(full)).size });
    }
  }
  await walk(base);
  return { entries: out, truncated };
}

export async function readText(roots: Roots, rootId: string, rel: string, max = 2_000_000): Promise<{ content: string; masked: boolean; size: number }> {
  const p = await roots.resolve(rootId, rel, { mustExist: true });
  const st = await fs.stat(p);
  if (!st.isFile()) throw new FsError(400, "Not a file");
  if (st.size > max) throw new FsError(413, `File is larger than ${max} bytes`);
  const buf = await fs.readFile(p);
  if (SECRET_FILE.test(rel)) return { content: maskEnv(buf.toString("utf8")), masked: true, size: st.size };
  return { content: buf.toString("utf8"), masked: false, size: st.size };
}

export function maskEnv(text: string): string {
  const names = dotenvNames(text);
  return `# Values hidden by OmniForge. Variable names only:\n${names.map((n) => `${n}=[HIDDEN]`).join("\n")}\n`;
}

export async function writeText(roots: Roots, rootId: string, rel: string, content: string) {
  const root = roots.get(rootId);
  if (!root.writable) throw new FsError(403, "This folder was approved read-only");
  const p = await roots.resolve(rootId, rel);
  if (SECRET_FILE.test(rel)) throw new FsError(403, "Refusing to write credential-style files");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
  return { path: rel, bytes: Buffer.byteLength(content) };
}

export async function snapshotFolder(roots: Roots, rootId: string, o: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number; sub?: string } = {}): Promise<{ files: InputFile[]; skipped: { path: string; reason: string }[] }> {
  const { entries, truncated } = await listTree(roots, rootId, { max: (o.maxFiles ?? 20_000) + 5000, sub: o.sub });
  const files: InputFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let total = 0;
  for (const e of entries) {
    if (e.type !== "file") continue;
    if ((e.size ?? 0) > (o.maxFileBytes ?? 8_000_000)) { skipped.push({ path: e.path, reason: "file too large" }); continue; }
    if (files.length >= (o.maxFiles ?? 20_000)) { skipped.push({ path: e.path, reason: "file-count limit" }); continue; }
    if (total + (e.size ?? 0) > (o.maxTotalBytes ?? 400_000_000)) { skipped.push({ path: e.path, reason: "total size limit" }); continue; }
    try {
      const p = await roots.resolve(rootId, e.path, { mustExist: true });
      let data: Uint8Array = await fs.readFile(p);
      if (SECRET_FILE.test(e.path)) data = new TextEncoder().encode(maskEnv(Buffer.from(data).toString("utf8")));
      total += data.byteLength;
      files.push({ path: e.path, data, origin: `local:${roots.get(rootId).label}`, provenance: "user" });
    } catch (err) { skipped.push({ path: e.path, reason: (err as Error).message }); }
  }
  if (truncated) skipped.push({ path: "(more files)", reason: "listing truncated" });
  return { files, skipped };
}
