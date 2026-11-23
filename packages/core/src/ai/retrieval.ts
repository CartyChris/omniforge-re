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

/** The Investigation Detail tab that shows a chunk of each kind, for deep links from cross-investigation search. */
export const CHUNK_TAB: Record<Chunk["kind"], string> = { evidence: "evidence", page: "pages", file: "files", endpoint: "apis", feature: "features", finding: "findings" };

export interface CrossHit { investigationId: string; investigationName: string; kind: Chunk["kind"]; chunkId: string; label: string; snippet: string; score: number }

const indexOf = (inv: Investigation) => { let ix = indexCache.get(inv); if (!ix) { ix = buildIndex(investigationChunks(inv)); indexCache.set(inv, ix); } return ix; };

/** ~`width` characters of `text` around the first occurrence of any query term (the start of the text when none occurs literally). */
export function snippetFor(text: string, terms: string[], width = 160): string {
  const flat = text.replace(/\s+/g, " ").trim(); const low = flat.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return flat.slice(0, width) + (flat.length > width ? "…" : "");
  const start = Math.max(0, at - Math.floor(width / 3)); const end = Math.min(flat.length, start + width);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

/**
 * BM25 over the chunks of every investigation at once: term statistics (N, df, average length) are pooled across all of
 * them so scores are comparable, while each investigation's tokenised index is built once and cached per object (WeakMap).
 */
export function searchInvestigations(invs: readonly Investigation[], query: string, k = 20): CrossHit[] {
  const q = [...new Set(tokenize(query))]; if (!q.length || k <= 0) return [];
  const ixs = invs.map(indexOf);
  let N = 0, total = 0; const df = new Map<string, number>();
  for (const ix of ixs) { N += ix.chunks.length; total += ix.len.reduce((a, b) => a + b, 0); for (const t of q) { const n = ix.df.get(t); if (n) df.set(t, (df.get(t) ?? 0) + n); } }
  const avg = total / Math.max(1, N) || 1;
  const scored: (CrossHit & { o: number })[] = []; let o = 0;
  ixs.forEach((ix, j) => {
    const inv = invs[j]!;
    for (let i = 0; i < ix.chunks.length; i++, o++) {
      let s = 0;
      for (const t of q) {
        const f = ix.tf[i]!.get(t); if (!f) continue;
        const n = df.get(t)!; const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * (f * 2.2) / (f + 1.2 * (1 - 0.75 + 0.75 * ix.len[i]! / avg));
      }
      if (s <= 0) continue;
      const ch = ix.chunks[i]!;
      scored.push({ investigationId: inv.id, investigationName: inv.name, kind: ch.kind, chunkId: ch.id, label: ch.label, snippet: snippetFor(`${ch.text} ${ch.label}`, q), score: s, o });
    }
  });
  return scored.sort((a, b) => b.score - a.score || a.o - b.o).slice(0, k).map(({ o: _o, ...h }) => h);
}
