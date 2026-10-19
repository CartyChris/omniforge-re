/** Agent Skills available to OmniForge's own agents: built-in, imported into this browser, and (desktop) the ones already on this Mac. */
import { BUILTIN_SKILLS, parseSkillBundle, readZip, type SkillPack, type SkillProblem } from "@omniforge/core";
import { db } from "./storage";
import { useApp } from "./store";
import { audit } from "./audit";

const IMPORTED = "skills:imported"; const DISABLED = "skills:disabled";
export type SkillEntry = SkillPack & { origin: string };

export async function importedSkills(): Promise<SkillEntry[]> { return ((await db.get<SkillEntry[]>(IMPORTED)) ?? []); }
export async function disabledSkills(): Promise<string[]> { return (await db.get<string[]>(DISABLED)) ?? []; }
export async function setSkillEnabled(name: string, on: boolean) { const d = new Set(await disabledSkills()); on ? d.delete(name) : d.add(name); await db.set(DISABLED, [...d]); void audit(on ? "skill enabled" : "skill disabled", name); }

/** Skills found on this Mac by the desktop engine (empty in the browser). */
export async function macSkills(): Promise<{ skills: SkillEntry[]; problems: SkillProblem[] }> {
  const b = useApp.getState().bridge; if (!b || useApp.getState().bridgeState !== "connected") return { skills: [], problems: [] };
  try { return await b.get<{ skills: SkillEntry[]; problems: SkillProblem[] }>("/bridge/skills"); } catch { return { skills: [], problems: [] }; }
}

/** All skills, first occurrence of a name wins (built-in → imported → Mac). */
export async function allSkills(): Promise<{ skills: SkillEntry[]; problems: SkillProblem[]; disabled: string[] }> {
  const [imp, mac, disabled] = await Promise.all([importedSkills(), macSkills(), disabledSkills()]);
  const out: SkillEntry[] = []; const seen = new Set<string>();
  for (const s of [...BUILTIN_SKILLS.map((x) => ({ ...x, origin: "Built in" })), ...imp, ...mac.skills]) if (!seen.has(s.name)) { seen.add(s.name); out.push(s); }
  return { skills: out, problems: mac.problems, disabled };
}

export async function enabledSkills(): Promise<SkillPack[]> { const { skills, disabled } = await allSkills(); return skills.filter((s) => !disabled.includes(s.name)); }

/** Import a .zip (one or many skills) or a set of files from a chosen folder / a single SKILL.md. */
export async function importSkillFiles(files: File[]): Promise<{ added: string[]; problems: SkillProblem[] }> {
  const entries: { path: string; content: string }[] = [];
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (/\.zip$/i.test(f.name)) { const z = readZip(new Uint8Array(await f.arrayBuffer()), { maxTotalBytes: 20_000_000 }); for (const e of z.entries) entries.push({ path: `${f.name}/${e.path}`, content: new TextDecoder().decode(e.data) }); }
    else if (f.size <= 200_000) entries.push({ path: rel, content: await f.text() });
  }
  const r = parseSkillBundle(entries, "import");
  const cur = await importedSkills(); const names = new Set(r.skills.map((s) => s.name));
  await db.set(IMPORTED, [...cur.filter((s) => !names.has(s.name)), ...r.skills.map((s) => ({ ...s, origin: "Imported" }))]);
  if (r.skills.length) void audit("skills imported", r.skills.map((s) => s.name).join(", "));
  return { added: r.skills.map((s) => s.name), problems: r.problems };
}
export async function removeImportedSkill(name: string) { await db.set(IMPORTED, (await importedSkills()).filter((s) => s.name !== name)); void audit("skill removed", name); }
