import { memo, useEffect, useMemo, useState } from "react";
import { Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import type { Graph, GraphNode } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const COLORS: Record<string, string> = { page: "var(--info)", asset: "var(--faint)", module: "var(--accent)", tech: "var(--teal)", feature: "var(--ok)", endpoint: "var(--warn)", file: "var(--muted)", service: "var(--teal)", dir: "var(--faint)" };
const W = 188, H = 40;

const GNode = memo(({ data, selected }: NodeProps<Node<{ label: string; type: string }>>) => (
  <div className={cn("flex h-10 items-center gap-2 rounded-lg border bg-surface px-2.5 text-xs shadow-sm transition", selected ? "border-accent ring-2 ring-accent/30" : "border-line hover:border-line-strong")} style={{ width: W, borderLeft: `3px solid ${COLORS[data.type] ?? "var(--line-strong)"}` }}>
    <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-line-strong" />
    <span className="truncate font-medium" title={data.label}>{data.label}</span>
    <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-line-strong" />
  </div>
));
GNode.displayName = "GNode";
const nodeTypes = { g: GNode };

export function layout(g: Graph, dir: "LR" | "TB" = "LR"): { nodes: Node[]; edges: Edge[] } {
  const d = new dagre.graphlib.Graph(); d.setGraph({ rankdir: dir, nodesep: 14, ranksep: 70, marginx: 20, marginy: 20 }); d.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const n of g.nodes) d.setNode(n.id, { width: W, height: H });
  const edges = g.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  for (const e of edges) d.setEdge(e.source, e.target);
  dagre.layout(d);
  return {
    nodes: g.nodes.map((n) => { const p = d.node(n.id); return { id: n.id, type: "g", position: { x: p.x - W / 2, y: p.y - H / 2 }, data: { label: n.label, type: n.type }, sourcePosition: Position.Right, targetPosition: Position.Left } as Node; }),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: false, style: { stroke: "var(--line-strong)", strokeWidth: 1.2 }, label: undefined }) as Edge),
  };
}

export const MAX_NODES = 220;
export function GraphView({ graph, onSelect, selected, dir = "LR", empty }: { graph: Graph; onSelect?: (n: GraphNode) => void; selected?: string; dir?: "LR" | "TB"; empty?: string }) {
  const theme = useApp((s) => s.settings.theme);
  const [capped, setCapped] = useState(false);
  const laid = useMemo(() => {
    let nodes = graph.nodes; let over = false;
    if (nodes.length > MAX_NODES) { over = true; const deg = new Map<string, number>(); for (const e of graph.edges) { deg.set(e.source, (deg.get(e.source) ?? 0) + 1); deg.set(e.target, (deg.get(e.target) ?? 0) + 1); } nodes = [...nodes].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0)).slice(0, MAX_NODES); }
    return { over, ...layout({ nodes, edges: graph.edges }, dir) };
  }, [graph, dir]);
  useEffect(() => setCapped(laid.over), [laid.over]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  if (!graph.nodes.length) return <div className="grid h-full min-h-64 place-items-center text-sm text-muted">{empty ?? "Nothing to draw for this view."}</div>;
  return (
    <div className="relative h-full min-h-[22rem] w-full overflow-hidden rounded-xl border border-line bg-bg" data-testid="graph">
      <ReactFlow nodes={laid.nodes.map((n) => ({ ...n, selected: n.id === selected }))} edges={laid.edges} nodeTypes={nodeTypes} colorMode={theme} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.1} maxZoom={1.8} nodesDraggable={false} nodesConnectable={false} proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => { const g = byId.get(n.id); if (g) onSelect?.(g); }}>
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--line)" />
        <Controls showInteractive={false} className="!overflow-hidden !rounded-lg !border !border-line !bg-surface !shadow-none" />
        <MiniMap pannable zoomable className="!hidden !rounded-lg !border !border-line !bg-surface md:!block" nodeColor={(n) => COLORS[(n.data as { type: string }).type] ?? "var(--line-strong)"} maskColor="color-mix(in oklab, var(--bg) 70%, transparent)" />
      </ReactFlow>
      <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-1.5">{[...new Set(graph.nodes.map((n) => n.type))].map((t) => <span key={t} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/90 px-2 py-0.5 text-[11px] text-muted"><span className="size-2 rounded-full" style={{ background: COLORS[t] }} />{t}</span>)}</div>
      {capped && <div className="absolute bottom-3 left-3 rounded-lg border border-warn/30 bg-surface/95 px-2.5 py-1.5 text-[11px] text-warn">Showing the {MAX_NODES} best-connected of {graph.nodes.length} nodes — the full graph is in the JSON export.</div>}
    </div>
  );
}
