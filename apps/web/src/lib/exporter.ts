import { exportBundle, graphExport, renderHtml, renderMarkdown, mermaidSitemap, mermaidStack, type Investigation } from "@omniforge/core";
import { download } from "./utils";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "report";

export type ExportFormat = "json" | "md" | "html" | "pdf" | "graph" | "mermaid" | "zip";
export const EXPORTS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: "zip", label: "Full bundle (ZIP)", hint: "report + graph + evidence + recovered sources" },
  { id: "html", label: "HTML report", hint: "self-contained, printable" },
  { id: "pdf", label: "PDF (print)", hint: "opens your browser's print dialog" },
  { id: "md", label: "Markdown", hint: "20-section report" },
  { id: "json", label: "JSON", hint: "everything, machine-readable" },
  { id: "graph", label: "Graph JSON", hint: "nodes & edges" },
  { id: "mermaid", label: "Mermaid diagrams", hint: "sitemap + stack" },
];

export function exportInvestigation(inv: Investigation, fmt: ExportFormat) {
  const base = slug(inv.name);
  switch (fmt) {
    case "zip": return download(`${base}-analysis.zip`, exportBundle(inv), "application/zip");
    case "html": return download(`${base}-report.html`, renderHtml(inv), "text/html");
    case "md": return download(`${base}-report.md`, renderMarkdown(inv), "text/markdown");
    case "json": return download(`${base}.json`, JSON.stringify(inv, null, 2), "application/json");
    case "graph": return download(`${base}-graph.json`, JSON.stringify(graphExport(inv), null, 2), "application/json");
    case "mermaid": return download(`${base}-diagrams.md`, `# ${inv.name}\n\n## Sitemap\n\n\`\`\`mermaid\n${mermaidSitemap(inv)}\n\`\`\`\n\n## Stack\n\n\`\`\`mermaid\n${mermaidStack(inv)}\n\`\`\`\n`, "text/markdown");
    case "pdf": {
      // render the (escaped) HTML report in a hidden sandboxed iframe and print it
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-modals allow-same-origin");
      f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
      f.srcdoc = renderHtml(inv);
      f.onload = () => { f.contentWindow?.focus(); f.contentWindow?.print(); setTimeout(() => f.remove(), 60_000); };
      document.body.appendChild(f);
    }
  }
}
