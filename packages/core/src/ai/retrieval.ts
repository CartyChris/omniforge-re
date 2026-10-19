/**
 * Question-aware context for Ask/Chat: BM25 over an investigation's evidence, page copy, source files, endpoints and features.
 * Without it the prompt carried the first 120 evidence items and the first pages whatever was asked, so a question about
 * item 300 or about a file's code could not be answered from the analysis. Lexical on purpose: deterministic, no model,
 * works offline in the browser; identifiers are split (camelCase, snake_case, paths) so code and URLs match plain words.
 */
import type { Investigation } from "../schema";
import { untrusted } from "./untrusted";

export interface Chunk { id: string; kind: "evidence" | "page" | "file" | "endpoint" | "feature" | "finding"; label: string; text: string }

const STOP = new Set("a an and are as at be by do does for from has have how i in is it its of on or that the this to was what when where which who why with you your can there their them".split(" "));

export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw); // crude plural folding: "endpoints" ~ "endpoint"
  }
  return out;
}

const path = (u: string) => { try { return new URL(u).pathname; } catch { return u; } };

/** Split long text into overlapping windows so one relevant paragraph is not drowned by a long file. */
function windows(text: string, size: number, overlap: number): { start: number; text: string }[] {
  if (text.length <= size) return [{ start: 0, text }];
  const out: { start: number; text: string }[] = [];
  for (let i = 0; i < text.length; i += size - overlap) { out.push({ start: i, text: text.slice(i, i + size) }); if (i + size >= text.length) break; }
  return out;
}
const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

export function investigationChunks(inv: Investigation): Chunk[] {
  const c: Chunk[] = [];
  for (const e of inv.evidence) c.push({ id: e.id, kind: "evidence", label: `${e.id} [${e.kind}] ${e.source}`, text: `${e.summary}\n${e.snippet ?? ""}\n${e.source}` });
  for (const p of inv.pages) {
    const head = `${path(p.url)} “${p.title}” ${p.headings.map((h) => h.text).join(" | ")} ${p.forms.map((f) => `form ${f.method} ${f.action} ${f.fields.map((x) => x.label ?? x.name).join(" ")}`).join(" ")}`;
    if (!p.text) { c.push({ id: p.id, kind: "page", label: path(p.url), text: head }); continue; }
    for (const [i, w] of windows(p.text, 1_200, 200).entries()) c.push({ id: `${p.id}#${i}`, kind: "page", label: `${path(p.url)}${i ? ` (part ${i + 1})` : ""}`, text: `${head}\n${w.text}` });
  }
  for (const f of inv.files) {
    if (!f.content) { c.push({ id: f.path, kind: "file", label: f.path, text: f.path }); continue; }
    for (const w of windows(f.content, 1_800, 300)) c.push({ id: `${f.path}:${lineAt(f.content, w.start)}`, kind: "file", label: `${f.path}:${lineAt(f.content, w.start)}`, text: `${f.path}\n${w.text}` });
  }
  for (const e of inv.endpoints) c.push({ id: `${e.method ?? "?"} ${e.url}`, kind: "endpoint", label: `${e.kind} ${e.method ?? "?"} ${e.url}`, text: `${e.kind} ${e.method ?? ""} ${e.url} found in ${e.foundIn} ${e.evidence}` });
  for (const f of inv.features) c.push({ id: f.id, kind: "feature", label: `${f.name} [${f.provenance}]`, text: `${f.name} ${f.category} ${f.description} ${f.files.join(" ")} ${JSON.stringify(f.spec).slice(0, 1_500)}` });
  for (const f of inv.findings) c.push({ id: f.id, kind: "finding", label: `${f.severity} ${f.area}: ${f.title}`, text: `${f.title} ${f.area} ${f.detail}` });
  return c;
}

export interface Bm25Index { chunks: Chunk[]; tf: Map<string, number>[]; len: number[]; df: Map<string, number>; avg: number }

export function buildIndex(chunks: Chunk[]): Bm25Index {
  const tf: Map<string, number>[] = []; const len: number[] = []; const df = new Map<string, number>();
  for (const ch of chunks) {
    const m = new Map<string, number>(); const toks = tokenize(`${ch.label} ${ch.text}`);
    for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
    for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    tf.push(m); len.push(toks.length);
  }
  return { chunks, tf, len, df, avg: len.reduce((a, b) => a + b, 0) / Math.max(1, len.length) };
}

/** Okapi BM25 (k1 1.2, b 0.75). Returns chunks with a positive score, best first; ties keep document order. */
export function search(ix: Bm25Index, query: string, k = 12): { chunk: Chunk; score: number }[] {
  const q = [...new Set(tokenize(query))]; const N = ix.chunks.length;
  const scored: { chunk: Chunk; score: number; i: number }[] = [];
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (const t of q) {
      const f = ix.tf[i]!.get(t); if (!f) continue;
      const n = ix.df.get(t)!; const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (1 - 0.75 + 0.75 * ix.len[i]! / (ix.avg || 1)));
    }
    if (s > 0) scored.push({ chunk: ix.chunks[i]!, score: s, i });
  }
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, k).map(({ chunk, score }) => ({ chunk, score }));
}

const indexCache = new WeakMap<Investigation, Bm25Index>();

/**
 * The passages of `inv` most relevant to `question`, fenced as untrusted, within `budget` characters.
 * Recent conversation is folded into the query at lower weight so follow-ups ("and the second one?") still retrieve.
 */
export function relevantContext(inv: Investigation, question: string, o: { budget?: number; k?: number; history?: string } = {}): { text: string; hits: Chunk[] } {
  let ix = indexCache.get(inv); if (!ix) { ix = buildIndex(investigationChunks(inv)); indexCache.set(inv, ix); }
  const primary = search(ix, question, o.k ?? 16);
  const extra = o.history ? search(ix, o.history, 4).filter((h) => !primary.some((p) => p.chunk.id === h.chunk.id)) : [];
  const budget = o.budget ?? 16_000; const parts: string[] = []; const hits: Chunk[] = []; let used = 0;
  for (const { chunk } of [...primary, ...extra]) {
    const block = `--- ${chunk.kind}: ${chunk.label}\n${chunk.text.trim()}`;
    if (used + block.length > budget) { if (used > budget * 0.6) break; continue; }
    parts.push(block); hits.push(chunk); used += block.length;
  }
  return { text: parts.length ? untrusted("retrieved-passages", parts.join("\n\n"), budget + 200) : "", hits };
}
