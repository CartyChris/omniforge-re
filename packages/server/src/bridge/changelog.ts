/** Recoverable record of every modification the bridge makes to the user's machine/config. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = () => process.env.OMNIFORGE_HOME ?? path.join(os.homedir(), ".omniforge");

export interface Change { id: string; at: string; action: string; detail: string; backup?: string; files?: string[] }

export function record(c: Omit<Change, "id" | "at">): Change {
  const full: Change = { id: Math.random().toString(36).slice(2, 10), at: new Date().toISOString(), ...c };
  fs.mkdirSync(home(), { recursive: true });
  fs.appendFileSync(path.join(home(), "changes.jsonl"), JSON.stringify(full) + "\n", { mode: 0o600 });
  return full;
}

export function readChanges(): Change[] {
  try { return fs.readFileSync(path.join(home(), "changes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).reverse(); } catch { return []; }
}

/** Copy existing files into a timestamped backup dir (never overwrites, preserves originals). */
export function backupFiles(files: string[]): { dir: string; saved: string[] } {
  const dir = path.join(home(), "backups", new Date().toISOString().replace(/[:.]/g, "-"));
  const saved: string[] = [];
  for (const f of files) {
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
    const dest = path.join(dir, f.replace(/^\/+/, "").replace(/[/\\]/g, "__"));
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(f, dest);
    fs.writeFileSync(dest + ".origin", f);
    saved.push(f);
  }
  return { dir, saved };
}

/** Restore a backup directory's files to their original locations. */
export function restoreBackup(dir: string): string[] {
  const restored: string[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".origin"))) {
    const origin = fs.readFileSync(path.join(dir, f), "utf8");
    const src = path.join(dir, f.replace(/\.origin$/, ""));
    if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(origin), { recursive: true }); fs.copyFileSync(src, origin); restored.push(origin); }
  }
  record({ action: "restore", detail: `Restored ${restored.length} file(s) from ${dir}`, backup: dir, files: restored });
  return restored;
}

export function listBackups(): { dir: string; at: string; files: number }[] {
  const root = path.join(home(), "backups");
  try { return fs.readdirSync(root).sort().reverse().map((d) => ({ dir: path.join(root, d), at: d, files: fs.readdirSync(path.join(root, d)).filter((n) => n.endsWith(".origin")).length })); } catch { return []; }
}
export const omniforgeHome = home;
