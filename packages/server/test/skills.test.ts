import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSkills } from "../src/bridge/skills";

let home: string; let outside: string;
const md = (name: string, desc = "Does a thing.") => `---\nname: ${name}\ndescription: ${desc}\n---\nBody of ${name}.\n`;
const put = (rel: string, content: string) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "skills-home-")); outside = fs.mkdtempSync(path.join(os.tmpdir(), "skills-outside-"));
  put(".claude/skills/pdf/SKILL.md", md("pdf")); put(".claude/skills/pdf/references/forms.md", "# forms"); put(".claude/skills/pdf/blob.bin", "\u0000\u0001");
  put(".claude/skills/broken/SKILL.md", "no front matter");
  put(".codex/skills/pdf/SKILL.md", md("pdf", "Second copy.")); // duplicate name
  put(".agents/skills/shared-one/SKILL.md", md("shared-one"));
  put(".claude/plugins/marketplaces/acme/plugins/tools/skills/acme-lint/SKILL.md", md("acme-lint"));
  put(".config/omniforge/skills/mine/SKILL.md", md("mine"));
  fs.writeFileSync(path.join(outside, "secret.md"), "SECRET CONTENT"); fs.mkdirSync(path.join(home, ".agents/skills/shared-one/refs"), { recursive: true });
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(home, ".agents/skills/shared-one/refs/leak.md")); // link out of the skill folder
});
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

describe("scanSkills", () => {
  it("finds skills in Claude Code, plugin, shared-agents, Codex and OmniForge folders", () => {
    const r = scanSkills(home);
    expect(r.skills.map((s) => `${s.origin}:${s.name}`).sort()).toEqual(["Agents (shared):shared-one", "Claude Code plugins:acme-lint", "Claude Code:pdf", "OmniForge:mine"]);
    expect(r.searched.filter((s) => s.exists).length).toBe(5);
  });
  it("loads text resources but not binaries, and ignores links that leave the skill folder", () => {
    const r = scanSkills(home);
    expect(Object.keys(r.skills.find((s) => s.name === "pdf")!.files)).toEqual(["references/forms.md"]);
    const shared = r.skills.find((s) => s.name === "shared-one")!; expect(shared.files).toEqual({}); expect(JSON.stringify(r)).not.toContain("SECRET CONTENT");
  });
  it("reports invalid and duplicate skills instead of hiding them", () => {
    const p = scanSkills(home).problems.map((x) => x.problem).join(" | ");
    expect(p).toMatch(/front matter/); expect(p).toMatch(/“pdf” is installed more than once/);
  });
  it("an empty or missing home yields nothing (and does not throw)", () => {
    expect(scanSkills(path.join(home, "nope"))).toMatchObject({ skills: [], problems: [] });
  });
});
