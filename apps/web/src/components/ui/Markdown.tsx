import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Inline } from "@omniforge/core";
import { cn } from "@/lib/utils";

/** Renders model output as elements from parsed data — no HTML from the model is ever interpreted. */
function inl(nodes: Inline[], k = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${k}${i}`;
    if (n.t === "text") return <Fragment key={key}>{n.v}</Fragment>;
    if (n.t === "code") return <code key={key} className="rounded bg-elevated px-1 py-0.5 font-mono text-[0.85em]">{n.v}</code>;
    if (n.t === "strong") return <strong key={key} className="font-semibold text-fg">{inl(n.c, key)}</strong>;
    if (n.t === "em") return <em key={key}>{inl(n.c, key)}</em>;
    const external = /^https?:/i.test(n.href);
    return <a key={key} href={n.href} className="text-accent underline underline-offset-2" {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}>{inl(n.c, key)}</a>;
  });
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={cn("space-y-2 break-words", className)}>
      {blocks.map((b, i) => {
        if (b.t === "code") return <pre key={i} className="overflow-x-auto rounded-lg border border-line bg-elevated p-3 font-mono text-[12px] leading-relaxed">{b.v}</pre>;
        if (b.t === "heading") { const H = (["h3", "h4", "h5", "h6"] as const)[b.level - 1]!; return <H key={i} className={cn("font-semibold text-fg", b.level <= 2 ? "text-[15px]" : "text-sm")}>{inl(b.c)}</H>; }
        if (b.t === "list") { const L = b.ordered ? "ol" : "ul"; return <L key={i} className={cn("space-y-1 pl-5", b.ordered ? "list-decimal" : "list-disc")}>{b.items.map((it, j) => <li key={j}>{inl(it, `${i}.${j}.`)}</li>)}</L>; }
        if (b.t === "quote") return <blockquote key={i} className="whitespace-pre-wrap border-l-2 border-line pl-3 text-muted">{inl(b.c)}</blockquote>;
        if (b.t === "rule") return <hr key={i} className="border-line" />;
        return <p key={i} className="whitespace-pre-wrap">{inl(b.c)}</p>;
      })}
    </div>
  );
}
