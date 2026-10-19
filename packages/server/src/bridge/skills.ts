/**
 * Finds Agent Skills the user already has on this Mac (Claude Code, Codex, the cross-agent ~/.agents folder and OmniForge's own folder)
 * so OmniForge's agents can use the same skills. Read-only; only text files; size-capped; never follows a link out of the skills folder.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSkill, isSkill, type SkillPack, type SkillProblem } from "@omniforge/core";

export const skillDirs = (home = os.homedir()) => [
  { label: "Claude Code", dir: path.join(home, ".claude", "skills") },
  { label: "Claude Code plugins", dir: path.join(home, ".claude", "plugins") },
  { label: "Agents (shared)", dir: path.join(home, ".agents", "skills") },
  { label: "Codex", dir: path.join(home, ".codex", "skills") },
  { label: "OmniForge", dir: path.join(home, ".config", "omniforge", "skills") },
];

const MAX_FILE = 200_000; const MAX_SKILL = 2_000_000; const MAX_SKILLS = 300;
const TEXT = /\.(?:md|markdown|txt|json|ya?ml|toml|csv|xml|html?|css|m?js|cjs|ts|tsx|jsx|py|rb|sh|go|rs|java|kt|swift|c|h|cpp|cs|php|sql|ini|svg|graphql|lua)$/i;

function readSkillFolder(dir: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = []; let total = 0;
  const real = fs.realpathSync(dir);
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(d, e.name); let st: fs.Stats; try { st = fs.statSync(p); } catch { continue; }
      let rp: string; try { rp = fs.realpathSync(p); } catch { continue; }
      if (!rp.startsWith(real + path.sep)) continue; // a link that leaves the skill folder is ignored
      if (st.isDirectory()) walk(p, depth + 1);
      else if (st.isFile() && (e.name === "SKILL.md" || TEXT.test(e.name)) && st.size <= MAX_FILE && total + st.size <= MAX_SKILL) { out.push({ path: path.relative(dir, p).split(path.sep).join("/"), content: fs.readFileSync(p, "utf8") }); total += st.size; }
    }
  };
  walk(dir, 0); return out;
}

/** Every folder under `root` (up to a few levels deep) that directly contains a SKILL.md. */
function findSkillFolders(root: string, maxDepth: number): string[] {
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > maxDepth || found.length >= MAX_SKILLS) return;
    let entries: fs.Dirent[]; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === "SKILL.md")) { found.push(d); return; }
    for (const e of entries) if (!e.name.startsWith(".") && e.name !== "node_modules" && (e.isDirectory() || e.isSymbolicLink())) { try { if (fs.statSync(path.join(d, e.name)).isDirectory()) walk(path.join(d, e.name), depth + 1); } catch { /* broken link */ } }
  };
  walk(root, 0); return found;
}

export function scanSkills(home = os.homedir()): { skills: (SkillPack & { origin: string })[]; problems: SkillProblem[]; searched: { label: string; dir: string; exists: boolean }[] } {
  const skills: (SkillPack & { origin: string })[] = []; const problems: SkillProblem[] = []; const seen = new Set<string>(); const searched = [];
  for (const { label, dir } of skillDirs(home)) {
    const exists = fs.existsSync(dir); searched.push({ label, dir, exists }); if (!exists) continue;
    for (const folder of findSkillFolders(dir, label.endsWith("plugins") ? 7 : 2)) {
      try {
        const r = parseSkill(readSkillFolder(folder), folder);
        if (!isSkill(r)) { problems.push(r); continue; }
        if (seen.has(r.name)) { problems.push({ path: folder, problem: `Skill “${r.name}” is installed more than once; the first one found is used` }); continue; }
        seen.add(r.name); skills.push({ ...r, origin: label });
      } catch (e) { problems.push({ path: folder, problem: (e as Error).message }); }
    }
  }
  return { skills, problems, searched };
}
