/**
 * Whole-file AI edits for the code workspace. The model only PROPOSES a replacement; nothing is written until the user
 * has seen the diff and accepts it. Everything here is pure so each guard can be tested (and mutation-checked):
 *  - the file is fenced as untrusted data (it may contain instructions aimed at the model),
 *  - files too large to send whole are refused instead of silently truncated,
 *  - replies that were cut off, contain no code block, are a no-op, or elide code with placeholders are rejected,
 *  - secret-like values that were not in the original are surfaced as warnings.
 */
import { SECURITY_PREAMBLE, untrusted } from "./untrusted.js";
import { redactForStorage } from "../util/redact.js";

export const MAX_EDIT_CHARS = 60_000;

export interface EditProblem { line: number; severity: "error" | "warning" | "info"; message: string }
export interface EditRequest { path: string; content: string; instruction: string; problems?: EditProblem[] }

export const EDIT_PRESETS = {
  fix: "Fix every problem listed below without changing behaviour that is not related to them.",
  refactor: "Refactor for readability and maintainability without changing behaviour or public interfaces.",
  comment: "Add concise, useful comments and doc comments where they help a reader. Do not change any code.",
  types: "Add or tighten type annotations. Do not change runtime behaviour.",
} as const;

export function buildEditPrompt(r: EditRequest): { system: string; prompt: string } {
  if (!r.instruction.trim()) throw new Error("Describe the change you want.");
  if (r.content.length > MAX_EDIT_CHARS) throw new Error(`${r.path} is ${Math.round(r.content.length / 1000)} kB — too large to send whole for an AI edit (limit ${MAX_EDIT_CHARS / 1000} kB). Split the file or select a smaller one.`);
  const problems = (r.problems ?? []).slice(0, 40).map((p) => `- line ${p.line} (${p.severity}): ${p.message}`).join("\n");
  const system = `${SECURITY_PREAMBLE}

You are a careful senior engineer editing ONE file for the user.
Reply with the COMPLETE new contents of the file in a single fenced code block, and nothing after it.
Never abbreviate: do not write placeholders such as "... rest unchanged" or "// existing code". Keep every line you were not asked to change exactly as it is.`;
  const prompt = `Instruction from the user (trusted): ${r.instruction.trim()}\n\nFile path: ${r.path}\n\n${untrusted(`file:${r.path}`, r.content, MAX_EDIT_CHARS)}${problems ? `\n\nEditor diagnostics for this file:\n${problems}` : ""}`;
  return { system, prompt };
}

export interface EditProposal { ok: true; content: string; added: number; removed: number; warnings: string[] }
export interface EditRejection { ok: false; reason: string }

const ELISION = /(?:\/\/|\/\*|#|<!--|--|;)\s*(?:\.{3}|…)\s*(?:the\s+)?(?:rest|remaining|existing|unchanged|other|previous|same)\b|(?:\/\/|\/\*|#|<!--)\s*(?:rest|remainder)\s+of\s+(?:the\s+)?(?:file|code|component|function|class)|\(?\s*(?:rest|remainder)\s+of\s+(?:the\s+)?(?:file|code)\s+(?:is\s+)?unchanged/i;

/** Pull the replacement file out of a model reply, or say precisely why it cannot be trusted. */
export function parseEditReply(reply: string, original: string): EditProposal | EditRejection {
  const fences = [...reply.matchAll(/^[ \t]*(`{3,})[\w+#.-]*[ \t]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm)];
  if (!fences.length) {
    return /^[ \t]*`{3,}/m.test(reply)
      ? { ok: false, reason: "The reply was cut off before the code block ended (token limit). Nothing was changed — try a smaller file or a more specific instruction." }
      : { ok: false, reason: "The model did not return a code block, so there is nothing to apply." };
  }
  // The largest block is the file; any others are commentary examples.
  let code = fences.reduce((a, b) => (b[2]!.length > a[2]!.length ? b : a))[2]!;
  const nl = original.includes("\r\n") ? "\r\n" : "\n";
  code = code.replace(/\r?\n/g, nl);
  // Models routinely add or drop a final newline; the file keeps its own convention (including a deliberate blank last line).
  code = code.replace(/(\r?\n)*$/, original.match(/(\r?\n)*$/)![0]);
  if (!code.trim()) return { ok: false, reason: "The proposed file is empty." };
  if (code === original) return { ok: false, reason: "The model returned the file unchanged." };
  const placeholder = code.split(/\r?\n/).find((l) => ELISION.test(l) && !original.includes(l.trim()));
  if (placeholder) return { ok: false, reason: `The model abbreviated the file instead of rewriting it (“${placeholder.trim().slice(0, 80)}”). Applying it would delete code. Nothing was changed.` };

  const warnings: string[] = [];
  const oldLines = original.split(/\r?\n/).length, newLines = code.split(/\r?\n/).length;
  if (oldLines >= 30 && newLines < oldLines * 0.4) warnings.push(`The file shrinks from ${oldLines} to ${newLines} lines — check that nothing was dropped.`);
  const before = new Set(redactForStorage("x.env", original).kinds), after = redactForStorage("x.env", code).kinds.filter((k) => !before.has(k));
  if (after.length) warnings.push(`The proposal contains a secret-like value (${after.join(", ")}) that was not in the original. Replace it with an environment variable.`);
  const d = lineDiffStats(original, code);
  return { ok: true, content: code, added: d.added, removed: d.removed, warnings };
}

/** Added/removed line counts (LCS on the changed middle; prefix/suffix are trimmed first). */
export function lineDiffStats(a: string, b: string): { added: number; removed: number } {
  const x = a.split("\n"), y = b.split("\n");
  let s = 0; while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0; while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const m = x.slice(s, x.length - e), n = y.slice(s, y.length - e);
  if (!m.length || !n.length || m.length * n.length > 4_000_000) return { added: n.length, removed: m.length };
  let prev = new Uint32Array(n.length + 1), cur = new Uint32Array(n.length + 1);
  for (let i = 1; i <= m.length; i++) {
    for (let j = 1; j <= n.length; j++) cur[j] = m[i - 1] === n[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[n.length]!;
  return { added: n.length - lcs, removed: m.length - lcs };
}
