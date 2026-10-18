/**
 * Versioned JavaScript-library detection with known vulnerabilities, driven by the retire.js repository (Apache-2.0,
 * https://github.com/RetireJS/retire.js). The matching rules below are a re-implementation of retire's documented algorithm
 * (`uri`, `filename`, `filecontent`, `filecontentreplace` extractors; `below` / `atOrAbove` / `excludes` ranges); the DATA file is
 * supplied by the host at run time, so nothing here goes stale and no third-party text is bundled.
 *
 * Not implemented, and therefore never claimed: the `func` (run the library in a page), `ast` and `hashes` extractors.
 * A library that only those could identify is simply not detected.
 *
 * The repository is third-party DATA that contains regular expressions, so every rule is length-capped, compiled once inside
 * try/catch, and only ever run against a bounded amount of text.
 */
export interface RetireVuln {
  below?: string; atOrAbove?: string; excludes?: string[];
  severity?: string; cwe?: string[]; info?: string[];
  identifiers?: { summary?: string; CVE?: string[]; githubID?: string; [k: string]: unknown };
}
export interface RetireComponent {
  npmname?: string; bowername?: string[]; vulnerabilities?: RetireVuln[];
  extractors?: { uri?: string[]; filename?: string[]; filecontent?: string[]; filecontentreplace?: string[]; [k: string]: unknown };
}
export type RetireRepository = Record<string, RetireComponent>;

export interface DetectedLibrary {
  component: string; npmname?: string; version: string; detection: "uri" | "filename" | "filecontent" | "filecontentreplace"; url: string;
  vulnerabilities: { severity: "critical" | "high" | "medium" | "low" | "unknown"; summary: string; ids: string[]; below?: string; atOrAbove?: string; info: string[] }[];
}

/**
 * Rejects the classic catastrophic-backtracking shape: a group that itself contains an unbounded quantifier and is then repeated without a bound, e.g. `(a+)+`.
 * Genuine retire rules that repeat a group, such as `(.*\n)*`, consume a line each time (the body names a newline), so they cannot overlap and are kept.
 * This is a screen for hostile data, not a proof of safety; the text a rule can run on is also length-capped.
 */
const NESTED = /\((?:[^()\\\n]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\\n]|\\.)*\)(?:[+*]|\{\d+,\d*\})/;
export const unsafeRule = (src: string): boolean => { const m = NESTED.exec(src); return !!m && !/\\n/.test(m[0]); };

const VERSION = "[0-9][0-9.a-z_\\\\-]+";
const MAX_RULE = 600; const MAX_CONTENT = 700_000; const MAX_MATCHES = 8;

/** Minimal shape check; unknown or malformed components are dropped rather than trusted. */
export function parseRepository(raw: unknown): { repo: RetireRepository; components: number; rules: number; dropped: number } {
  const repo: RetireRepository = {}; let rules = 0; let dropped = 0;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Not a retire.js repository (expected an object keyed by library name)");
  for (const [name, c] of Object.entries(raw as Record<string, unknown>)) {
    const ex = (c as RetireComponent | null)?.extractors;
    if (!c || typeof c !== "object" || !ex || typeof ex !== "object") { dropped++; continue; }
    const keep: NonNullable<RetireComponent["extractors"]> = {};
    for (const k of ["uri", "filename", "filecontent", "filecontentreplace"] as const) {
      const list = (ex as Record<string, unknown>)[k];
      if (Array.isArray(list)) { const ok = list.filter((r): r is string => typeof r === "string" && r.length <= MAX_RULE && !unsafeRule(r)); dropped += list.length - ok.length; if (ok.length) { keep[k] = ok; rules += ok.length; } }
    }
    if (!Object.keys(keep).length) continue;
    const vulns = Array.isArray((c as RetireComponent).vulnerabilities) ? (c as RetireComponent).vulnerabilities!.filter((v) => v && typeof v === "object") : [];
    repo[name] = { npmname: typeof (c as RetireComponent).npmname === "string" ? (c as RetireComponent).npmname : undefined, vulnerabilities: vulns, extractors: keep };
  }
  if (!Object.keys(repo).length) throw new Error("The retire.js repository contained no usable detection rules");
  return { repo, components: Object.keys(repo).length, rules, dropped };
}

/** retire's own comparison: dotted/dashed segments, numbers before strings, missing segments count as 0. */
export function isAtOrAbove(a: string, b: string): boolean {
  const x = a.split(/[.-]/); const y = b.split(/[.-]/); const n = Math.max(x.length, y.length);
  const cmp = (s?: string): number | string => (s === undefined ? 0 : /^[0-9]+$/.test(s) ? parseInt(s, 10) : s);
  for (let i = 0; i < n; i++) {
    const p = cmp(x[i]); const q = cmp(y[i]);
    if (typeof p !== typeof q) return typeof p === "number";
    if (p > q) return true;
    if (p < q) return false;
  }
  return true;
}

const compiled = new WeakMap<RetireRepository, Map<string, RegExp | null>>();
function re(repo: RetireRepository, src: string, flags: string): RegExp | null {
  let m = compiled.get(repo); if (!m) compiled.set(repo, (m = new Map()));
  const key = flags + src; if (m.has(key)) { const r = m.get(key)!; if (r) r.lastIndex = 0; return r; }
  let r: RegExp | null = null; try { r = new RegExp(src.replace(/§§version§§/g, VERSION), flags); } catch { r = null; }
  m.set(key, r); return r;
}

function matches(r: RegExp, text: string, group: (m: RegExpExecArray) => string | undefined): string[] {
  const out: string[] = []; r.lastIndex = 0; let m: RegExpExecArray | null;
  while ((m = r.exec(text)) && out.length < MAX_MATCHES) { if (m[0] === "") r.lastIndex++; const v = group(m); if (v) out.push(v.replace(/(\.|-)min$/, "")); }
  return out;
}

function sevOf(s?: string): DetectedLibrary["vulnerabilities"][number]["severity"] { const v = (s ?? "").toLowerCase(); return v === "critical" || v === "high" || v === "medium" || v === "low" ? v : "unknown"; }

function vulnsFor(c: RetireComponent, version: string): DetectedLibrary["vulnerabilities"] {
  const out: DetectedLibrary["vulnerabilities"] = [];
  for (const v of c.vulnerabilities ?? []) {
    if (v.below !== undefined && isAtOrAbove(version, v.below)) continue;
    if (v.atOrAbove !== undefined && !isAtOrAbove(version, v.atOrAbove)) continue;
    if (v.excludes?.includes(version)) continue;
    const id = v.identifiers ?? {}; const ids = [...(id.CVE ?? []), ...(id.githubID ? [id.githubID] : [])].filter((x): x is string => typeof x === "string");
    out.push({ severity: sevOf(v.severity), summary: String(id.summary ?? "Known vulnerability").slice(0, 300), ids, below: v.below, atOrAbove: v.atOrAbove, info: (v.info ?? []).filter((u) => /^https?:\/\//.test(u)).slice(0, 4) });
  }
  return out;
}

/**
 * Detect libraries from the URL of a script and (optionally) its text. A library found by several routes is reported once per version,
 * keeping the strongest route (content, then filename, then URL).
 */
export function detectLibraries(repo: RetireRepository, inputs: { url: string; content?: string }[]): DetectedLibrary[] {
  const found = new Map<string, DetectedLibrary>(); const strength = { filecontent: 3, filecontentreplace: 3, filename: 2, uri: 1 } as const;
  const add = (name: string, c: RetireComponent, version: string, detection: DetectedLibrary["detection"], url: string) => {
    if (!/^[0-9][0-9A-Za-z._-]{0,30}$/.test(version)) return;
    const k = `${name}@${version}`; const prev = found.get(k);
    if (prev && strength[prev.detection] >= strength[detection]) return;
    found.set(k, { component: name, npmname: c.npmname, version, detection, url, vulnerabilities: vulnsFor(c, version) });
  };
  for (const { url, content } of inputs) {
    const path = (() => { try { return new URL(url).pathname; } catch { return url; } })(); const file = path.split("/").pop() ?? "";
    const text = content === undefined ? undefined : content.slice(0, MAX_CONTENT).replace(/\r\n?/g, "\n");
    for (const [name, c] of Object.entries(repo)) {
      const ex = c.extractors ?? {};
      for (const s of ex.uri ?? []) { const r = re(repo, s, "g"); if (r) for (const v of matches(r, url, (m) => m[1])) add(name, c, v, "uri", url); }
      for (const s of ex.filename ?? []) { const r = re(repo, `^${s}$`, ""); const m = r?.exec(file); if (m?.[1]) add(name, c, m[1].replace(/(\.|-)min$/, ""), "filename", url); }
      if (text === undefined) continue;
      let hit = false;
      for (const s of ex.filecontent ?? []) { const r = re(repo, s, "g"); if (r) for (const v of matches(r, text, (m) => m[1])) { add(name, c, v, "filecontent", url); hit = true; } }
      if (hit) continue;
      for (const s of ex.filecontentreplace ?? []) {
        const p = /^\/(.*[^\\])\/([^/]+)\/$/.exec(s); if (!p) continue; const r = re(repo, p[1]!, "g"); const one = re(repo, p[1]!, "");
        if (r && one) for (const v of matches(r, text, (m) => m[0].replace(one, p[2]!))) add(name, c, v, "filecontentreplace", url);
      }
    }
  }
  return [...found.values()].sort((a, b) => b.vulnerabilities.length - a.vulnerabilities.length || a.component.localeCompare(b.component));
}
