/**
 * A small Markdown subset for model replies, parsed to data (never to HTML), so a UI can render it as elements and nothing a
 * model writes is ever interpreted as markup. Blocks: fenced code, headings, bullet/numbered lists, quotes, rules, paragraphs.
 * Inline: `code`, **bold**, *italic* / _italic_, [text](http(s) link). Unsafe link targets (javascript:, data:, …) stay text.
 */
export type Inline = { t: "text"; v: string } | { t: "code"; v: string } | { t: "strong"; c: Inline[] } | { t: "em"; c: Inline[] } | { t: "link"; href: string; c: Inline[] };
export type Block =
  | { t: "code"; lang?: string; v: string }
  | { t: "heading"; level: 1 | 2 | 3 | 4; c: Inline[] }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "quote"; c: Inline[] }
  | { t: "rule" }
  | { t: "para"; c: Inline[] };

const SAFE_URL = /^(?:https?:\/\/|mailto:|#|\/(?!\/))/i;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = []; let text = "";
  const flush = () => { if (text) { out.push({ t: "text", v: text }); text = ""; } };
  for (let i = 0; i < s.length;) {
    const rest = s.slice(i); let m: RegExpMatchArray | null;
    if ((m = rest.match(/^`([^`\n]+)`/))) { flush(); out.push({ t: "code", v: m[1]! }); i += m[0].length; continue; }
    if ((m = rest.match(/^\*\*(?=\S)([\s\S]*?\S)\*\*/)) || (m = rest.match(/^__(?=\S)([\s\S]*?\S)__/))) { flush(); out.push({ t: "strong", c: parseInline(m[1]!) }); i += m[0].length; continue; }
    if ((m = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/))) {
      if (SAFE_URL.test(m[2]!)) { flush(); out.push({ t: "link", href: m[2]!, c: parseInline(m[1]!) }); i += m[0].length; continue; }
      text += m[1]; i += m[0].length; continue; // unsafe target: keep the label only
    }
    if ((m = rest.match(/^\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/)) || ((i === 0 || /[\s(]/.test(s[i - 1]!)) && (m = rest.match(/^_(?=\S)([^_\n]*?\S)_(?![\w])/)))) { flush(); out.push({ t: "em", c: parseInline(m[1]!) }); i += m[0].length; continue; }
    text += s[i]; i++;
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = []; let para: string[] = [];
  const endPara = () => { if (para.length) { out.push({ t: "para", c: parseInline(para.join("\n")) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!; let m: RegExpMatchArray | null;
    if ((m = l.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/))) {
      endPara(); const fence = m[1]!; const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence); i++) body.push(lines[i]!);
      out.push({ t: "code", lang: m[2] || undefined, v: body.join("\n") }); continue; // an unclosed fence runs to the end (streaming)
    }
    if (!l.trim()) { endPara(); continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { endPara(); out.push({ t: "heading", level: Math.min(4, m[1]!.length) as 1 | 2 | 3 | 4, c: parseInline(m[2]!) }); continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { endPara(); out.push({ t: "rule" }); continue; }
    if ((m = l.match(/^\s*>\s?(.*)$/))) { endPara(); const q = [m[1]!]; while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]!)) q.push(lines[++i]!.replace(/^\s*>\s?/, "")); out.push({ t: "quote", c: parseInline(q.join("\n")) }); continue; }
    if ((m = l.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/))) {
      endPara(); const ordered = !m[1]; const items: Inline[][] = [parseInline(m[3]!)];
      const item = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      while (i + 1 < lines.length) {
        const n = lines[i + 1]!; const im = n.match(item);
        if (im) { items.push(parseInline(im[1]!)); i++; }
        else if (n.trim() && /^\s{2,}\S/.test(n) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(n)) { const last = items.pop()!; items.push([...last, { t: "text", v: " " }, ...parseInline(n.trim())]); i++; } // continuation line
        else break;
      }
      out.push({ t: "list", ordered, items }); continue;
    }
    para.push(l);
  }
  endPara();
  return out;
}
