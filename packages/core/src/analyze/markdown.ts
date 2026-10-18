/**
 * Page → Markdown. The crawler records structure (headings, forms, links); this keeps the page's actual COPY and layout in a compact,
 * readable form so that a rebuild can reproduce the real text, navigation labels, list/table content and form fields instead of inventing them.
 *
 * Text is whatever the site served; it is data, never instructions, and callers fence it (see untrusted.ts). Output is bounded: total length,
 * nesting depth, table size and list-item count are all capped.
 */
import { load } from "cheerio/slim";

export interface MarkdownOptions { maxChars?: number; maxDepth?: number }
export interface MarkdownResult { text: string; truncated: boolean }

type N = { type: string; name?: string; data?: string; attribs?: Record<string, string>; children?: N[] };
const SKIP = new Set(["script", "style", "noscript", "template", "svg", "iframe", "head", "link", "meta", "object", "embed", "map", "datalist"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "form", "figure", "figcaption", "fieldset", "details", "summary", "address", "dl", "dt", "dd", "body", "html", "center", "legend"]);
const LANDMARK = new Set(["nav", "header", "footer", "aside", "main"]);
const hidden = (a: Record<string, string> = {}) => "hidden" in a || a["aria-hidden"] === "true" || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(a.style ?? "");
const ws = (s: string) => s.replace(/\s+/g, " ");
// "_" is deliberately not escaped: intra-word underscores are not emphasis in CommonMark, and escaping them breaks identifiers and secret detection.
const esc = (s: string) => s.replace(/([\\`*\[\]|])/g, "\\$1");

export function htmlToMarkdown(html: string, pageUrl: string, o: MarkdownOptions = {}): MarkdownResult {
  const maxChars = o.maxChars ?? 8000; const maxDepth = o.maxDepth ?? 120;
  let base: URL | null = null; try { base = new URL(pageUrl); } catch { base = null; }
  const abs = (u: string | undefined): string => {
    const v = (u ?? "").trim(); if (!v || /^\s*javascript:/i.test(v)) return "";
    if (/^data:/i.test(v)) return "data-uri";
    try { const x = new URL(v, base ?? undefined); return base && x.origin === base.origin ? x.pathname + x.search + x.hash : x.toString(); } catch { return v.slice(0, 200); }
  };
  const $ = load(html, { xml: false });
  const out: string[] = []; let size = 0; let truncated = false;
  const emit = (s: string) => { if (truncated || !s) return; if (size + s.length > maxChars) { out.push(s.slice(0, Math.max(0, maxChars - size))); truncated = true; size = maxChars; return; } out.push(s); size += s.length; };

  // Inline content of a node as one line of Markdown.
  function inline(n: N, depth: number): string {
    if (depth > maxDepth) return "";
    if (n.type === "text") return esc(ws(n.data ?? ""));
    if (n.type !== "tag" || !n.name || SKIP.has(n.name) || hidden(n.attribs)) return "";
    const kids = () => (n.children ?? []).map((c) => inline(c, depth + 1)).join("");
    switch (n.name) {
      case "br": return " ";
      case "strong": case "b": { const t = kids().trim(); return t ? `**${t}**` : ""; }
      case "em": case "i": { const t = kids().trim(); return t ? `*${t}*` : ""; }
      case "code": case "kbd": case "samp": { const t = textOf(n).trim(); return t ? "`" + t.replace(/`/g, "'") + "`" : ""; }
      case "a": { const t = kids().trim(); const raw = (n.attribs?.href ?? "").trim(); const h = raw.startsWith("#") ? raw : abs(raw); if (!h) return t; if (h.startsWith("#") && !t) return ""; return `[${t || "link"}](${h})`; }
      case "img": { const alt = ws(n.attribs?.alt ?? "").trim(); const s = abs(n.attribs?.src ?? n.attribs?.["data-src"]); return s ? `![${esc(alt)}](${s})` : alt ? `[image: ${esc(alt)}]` : ""; }
      case "button": return `[button: ${ws(textOf(n)).trim() || n.attribs?.["aria-label"] || n.attribs?.value || "unlabelled"}]`;
      case "input": { const t = (n.attribs?.type ?? "text").toLowerCase(); if (t === "hidden") return ""; const label = n.attribs?.["aria-label"] || n.attribs?.placeholder || n.attribs?.name || ""; return t === "submit" || t === "button" ? `[button: ${n.attribs?.value || "submit"}]` : `[input ${t}${label ? `: ${esc(label)}` : ""}${"required" in (n.attribs ?? {}) ? " (required)" : ""}]`; }
      case "textarea": return `[textarea${n.attribs?.placeholder || n.attribs?.name ? `: ${esc(n.attribs?.placeholder || n.attribs?.name || "")}` : ""}]`;
      case "select": { const opts = (n.children ?? []).flatMap((c) => (c.name === "optgroup" ? c.children ?? [] : [c])).filter((c) => c.name === "option").map((c) => ws(textOf(c)).trim()).filter(Boolean); return `[select${n.attribs?.name ? " " + n.attribs.name : ""}: ${opts.slice(0, 8).join(" | ")}${opts.length > 8 ? " | …" : ""}]`; }
      case "video": case "audio": case "canvas": return `[${n.name}]`;
      default: return kids();
    }
  }
  function textOf(n: N, depth = 0): string { if (depth > maxDepth) return ""; if (n.type === "text") return n.data ?? ""; if (n.type !== "tag" || (n.name && SKIP.has(n.name))) return ""; return (n.children ?? []).map((c) => textOf(c, depth + 1)).join(" "); }

  function table(n: N) {
    const rows: string[][] = []; const walk = (x: N, d: number) => { if (d > 12) return; for (const c of x.children ?? []) { if (c.name === "tr") rows.push((c.children ?? []).filter((k) => k.name === "td" || k.name === "th").slice(0, 8).map((k) => ws(inlineAll(k)).trim())); else if (c.type === "tag") walk(c, d + 1); } };
    walk(n, 0); const shown = rows.filter((r) => r.length).slice(0, 30); if (!shown.length) return;
    const w = Math.max(...shown.map((r) => r.length)); const line = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => r[i] ?? "").join(" | ")} |`;
    emit("\n" + [line(shown[0]!), line(Array(w).fill("---")), ...shown.slice(1).map(line)].join("\n") + (rows.length > shown.length ? "\n| … |" : "") + "\n\n");
  }
  const inlineAll = (n: N) => (n.children ?? []).map((c) => inline(c, 1)).join("");

  function list(n: N, depth: number, indent: string) {
    let i = 0; const ordered = n.name === "ol";
    for (const li of (n.children ?? []).filter((c) => c.name === "li").slice(0, 80)) {
      if (truncated) return; if (hidden(li.attribs)) continue; i++;
      const text = (li.children ?? []).filter((c) => !(c.name === "ul" || c.name === "ol")).map((c) => inline(c, depth + 1)).join("").trim();
      if (text) emit(`${indent}${ordered ? `${i}.` : "-"} ${text}\n`);
      for (const sub of (li.children ?? []).filter((c) => c.name === "ul" || c.name === "ol")) if (depth < 8) list(sub, depth + 1, indent + "  ");
    }
  }

  function block(n: N, depth: number) {
    if (truncated || depth > maxDepth) return;
    if (n.type === "text") { const t = ws(n.data ?? "").trim(); if (t) emit(esc(t) + "\n\n"); return; }
    if (n.type !== "tag" || !n.name || SKIP.has(n.name) || hidden(n.attribs)) return;
    const name = n.name;
    if (/^h[1-6]$/.test(name)) { const t = ws(inlineAll(n)).trim(); if (t) emit(`\n${"#".repeat(Number(name[1]))} ${t}\n\n`); return; }
    if (name === "ul" || name === "ol") { list(n, depth, ""); emit("\n"); return; }
    if (name === "table") return table(n);
    if (name === "pre") { const t = textOf(n).replace(/\r/g, "").replace(/\n+$/, ""); if (t.trim()) emit("\n```\n" + t.replace(/```/g, "'''") + "\n```\n\n"); return; }
    if (name === "hr") return emit("\n---\n\n");
    if (name === "blockquote") { const t = ws(inlineAll(n)).trim(); if (t) emit(`> ${t}\n\n`); return; }
    if (BLOCK.has(name) || name === "li") {
      if (LANDMARK.has(name)) emit(`\n[${name}]\n`);
      // inline runs between nested blocks are grouped into one paragraph
      let run = ""; const flush = () => { const t = run.trim(); if (t) emit(t + "\n\n"); run = ""; };
      for (const c of n.children ?? []) {
        if (c.type === "tag" && c.name && (BLOCK.has(c.name) || /^h[1-6]$/.test(c.name) || ["ul", "ol", "table", "pre", "hr", "blockquote", "li"].includes(c.name))) { flush(); block(c, depth + 1); } else run += inline(c, depth + 1) + (c.type === "tag" && c.name === "br" ? "\n" : "");
      }
      flush(); return;
    }
    const t = ws(inline(n, depth)).trim(); if (t) emit(t + "\n\n");
  }

  const root = $.root().get(0) as unknown as N; for (const c of root.children ?? []) block(c, 0);
  const text = out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + (truncated ? "\n\n… [page text truncated]" : "");
  return { text, truncated };
}
