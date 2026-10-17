import { useMemo, useState } from "react";
import type { Graph, GraphNode, Investigation } from "@omniforge/core";
import { Card, CardBody, Segmented, Badge } from "@/components/ui/primitives";
import { GraphView } from "./GraphView";
import { EvidenceChips, useEvidence } from "./EvidenceLink";

type View = "sitemap" | "links" | "loading" | "stack" | "features" | "deps" | "apis" | "modules";
const LABEL: Record<View, string> = { sitemap: "Sitemap", links: "All links", loading: "Asset loading", stack: "Stack", features: "Features", deps: "Dependencies", apis: "APIs", modules: "Modules" };

const pick = (g: Graph, types: string[], edgeTypes?: string[]): Graph => {
  const nodes = g.nodes.filter((n) => types.includes(n.type)); const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: g.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && (!edgeTypes || edgeTypes.includes(e.type))) };
};

export function buildViews(inv: Investigation): Partial<Record<View, Graph>> {
  const g = inv.graph;
  const v: Partial<Record<View, Graph>> = {};
  // Sitemap = discovery tree (who first led to whom, else nearest path ancestor); the full link web is a separate, denser view.
  const pages = pick(g, ["page"]);
  if (pages.nodes.length > 1) {
    const byUrl = new Map(inv.pages.map((p) => [p.url, p])); const seed = inv.pages.find((p) => p.depth === 0) ?? inv.pages[0]!;
    const edges: Graph["edges"] = [];
    for (const p of inv.pages) {
      if (p.id === seed.id) continue;
      let parent = p.discoveredFrom ? byUrl.get(p.discoveredFrom) : undefined;
      if (!parent || parent.id === p.id) {
        try { const u = new URL(p.url); const segs = u.pathname.split("/").filter(Boolean); for (let i = segs.length - 1; i >= 0 && !parent; i--) { const cand = byUrl.get(`${u.origin}/${segs.slice(0, i).join("/")}${i ? "" : ""}`) ?? byUrl.get(`${u.origin}/${segs.slice(0, i).join("/")}/`); if (cand && cand.id !== p.id) parent = cand; } } catch { /* ignore */ }
      }
      edges.push({ id: `tree:${p.id}`, source: (parent ?? seed).id, target: p.id, type: "links" });
    }
    v.sitemap = { nodes: pages.nodes, edges };
    const links = pick(g, ["page"], ["links"]); if (links.edges.length) v.links = links;
  }
  const loading = pick(g, ["page", "asset"], ["loads"]); if (loading.edges.length) v.loading = loading;
  // stack: category → technology (+ the features that use them)
  const techs = inv.technologies.filter((t) => t.confidence >= 0.5);
  if (techs.length) {
    const cats = [...new Set(techs.map((t) => t.category))];
    const nodes: GraphNode[] = [...cats.map((c) => ({ id: `cat:${c}`, type: "service" as const, label: c })), ...techs.map((t) => ({ id: `tech:${t.name}`, type: "tech" as const, label: t.name + (t.version ? ` ${t.version}` : ""), data: { category: t.category, confidence: t.confidence } }))];
    v.stack = { nodes, edges: techs.map((t) => ({ id: `st:${t.name}`, source: `cat:${t.category}`, target: `tech:${t.name}`, type: "contains" as const })) };
  }
  const features = pick(g, ["feature", "page", "tech"], ["implements", "uses"]); if (features.nodes.some((n) => n.type === "feature")) v.features = { nodes: features.nodes.filter((n) => n.type === "feature" || features.edges.some((e) => e.source === n.id || e.target === n.id)), edges: features.edges };
  if (inv.dependencies.length) {
    const eco = [...new Set(inv.dependencies.map((d) => d.ecosystem))];
    const deps = inv.dependencies.filter((d) => !d.dev).slice(0, 140);
    const nodes: GraphNode[] = [...eco.map((e) => ({ id: `eco:${e}`, type: "dir" as const, label: e })), ...deps.map((d) => ({ id: `dep:${d.ecosystem}:${d.name}`, type: "module" as const, label: d.name + (d.version ? ` ${d.version}` : ""), data: { source: d.source } }))];
    v.deps = { nodes, edges: deps.map((d) => ({ id: `de:${d.ecosystem}:${d.name}`, source: `eco:${d.ecosystem}`, target: `dep:${d.ecosystem}:${d.name}`, type: "contains" as const })) };
  }
  const apis = pick(g, ["endpoint", "page", "asset"], ["calls"]); if (apis.edges.length) v.apis = apis;
  const modules = pick(g, ["file", "module", "dir", "service"], ["imports", "contains", "calls", "uses"]); if (modules.edges.length) v.modules = modules;
  return v;
}

export function GraphTab({ inv }: { inv: Investigation }) {
  const views = useMemo(() => buildViews(inv), [inv]);
  const keys = Object.keys(views) as View[];
  const [view, setView] = useState<View>(keys[0] ?? "sitemap");
  const [sel, setSel] = useState<GraphNode | null>(null);
  const { byId } = useEvidence();
  const g = views[view] ?? { nodes: [], edges: [] };
  const evidence = sel ? inv.evidence.filter((e) => e.related?.includes(sel.id) || (typeof sel.data?.url === "string" && e.source === sel.data.url)).map((e) => e.id).filter((id) => byId.has(id)) : [];
  if (!keys.length) return <Card><CardBody className="py-12 text-center text-sm text-muted">No relationships were found to draw (for example, a single page with no scripts). The inventory tabs still list everything that was observed.</CardBody></Card>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><Segmented value={view} onChange={(v) => { setView(v); setSel(null); }} options={keys.map((k) => ({ value: k, label: LABEL[k] }))} size="sm" className="max-w-full overflow-x-auto" /><span className="text-xs text-faint">{g.nodes.length} nodes · {g.edges.length} edges · click a node for details</span></div>
      <div className="grid gap-3 lg:grid-cols-[1fr_18rem]">
        <div className="h-[60dvh] min-h-[24rem]"><GraphView graph={g} onSelect={setSel} selected={sel?.id} dir={view === "stack" || view === "deps" ? "LR" : "LR"} /></div>
        <Card className="h-fit"><CardBody className="space-y-3 text-sm">
          {!sel ? <p className="text-[13px] text-muted">Select a node to see what it is and the evidence behind it.</p> : <>
            <div className="flex items-center gap-2"><Badge tone="accent">{sel.type}</Badge></div>
            <p className="break-words font-medium">{sel.label}</p>
            {sel.data && <dl className="space-y-1 text-[13px]">{Object.entries(sel.data).filter(([, v]) => v !== undefined && v !== "").slice(0, 8).map(([k, v]) => <div key={k} className="grid grid-cols-[5rem_1fr] gap-2"><dt className="text-faint">{k}</dt><dd className="break-all">{typeof v === "number" && k === "confidence" ? `${Math.round(v * 100)}%` : String(v)}</dd></div>)}</dl>}
            <div><div className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Evidence</div><EvidenceChips ids={evidence} max={6} /></div>
          </>}
        </CardBody></Card>
      </div>
    </div>
  );
}
