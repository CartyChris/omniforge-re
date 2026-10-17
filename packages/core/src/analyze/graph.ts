import type { Graph, GraphEdge, GraphNode, Investigation } from "../schema.js";
import { hashStr } from "../util/index.js";
import type { Facts } from "./facts.js";

const eid = (a: string, b: string, t: string) => `${t}:${hashStr(a + "|" + b)}`;

/**
 * One graph that powers every diagram: sitemap/navigation (page→page),
 * asset loading (page→asset), tech usage, features and API endpoints.
 * Each node carries an `id` that resolves to evidence in the UI.
 */
export function buildGraph(inv: Pick<Investigation, "pages" | "assets" | "technologies" | "features" | "endpoints" | "files">, extra: Graph | undefined, f: Facts): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const node = (n: GraphNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); };
  const edge = (source: string, target: string, type: GraphEdge["type"]) => {
    const id = eid(source, target, type);
    if (!edges.has(id)) edges.set(id, { id, source, target, type });
  };

  const pageByUrl = new Map(inv.pages.map((p) => [p.url, p]));
  for (const p of inv.pages) {
    node({ id: p.id, type: "page", label: pathLabel(p.url), data: { url: p.url, status: p.status, depth: p.depth, title: p.title } });
  }
  for (const p of inv.pages) {
    for (const l of p.links) {
      const t = pageByUrl.get(l.split("#")[0]!);
      if (t && t.id !== p.id) edge(p.id, t.id, "links");
    }
  }
  const assetByUrl = new Map(inv.assets.map((a) => [a.url, a]));
  for (const a of inv.assets) {
    if (a.kind === "image" || a.kind === "font" || a.kind === "media") continue; // keep the graph readable; they remain in the inventory
    node({ id: a.id, type: "asset", label: a.url.split("/").pop()?.split("?")[0] || a.url, data: { url: a.url, kind: a.kind, bytes: a.bytes } });
    for (const ref of a.referencedBy) {
      const p = pageByUrl.get(ref);
      if (p) edge(p.id, a.id, "loads");
      else {
        const parent = assetByUrl.get(ref);
        if (parent) edge(parent.id, a.id, "loads");
      }
    }
  }
  for (const t of inv.technologies) {
    node({ id: `tech:${t.name}`, type: "tech", label: t.name, data: { category: t.category, version: t.version, confidence: t.confidence } });
  }
  // tech ↔ asset when the evidence source is that asset
  const evSource = new Map(f.technologies.flatMap((t) => t.evidence.map((e) => [e, t.name] as const)));
  void evSource;
  for (const ft of inv.features) {
    node({ id: ft.id, type: "feature", label: ft.name, data: { category: ft.category, confidence: ft.confidence } });
    for (const pid of ft.pages.slice(0, 12)) if (nodes.has(pid)) edge(ft.id, pid, "implements");
    for (const d of ft.spec.dependencies) if (nodes.has(`tech:${d}`)) edge(ft.id, `tech:${d}`, "uses");
  }
  for (const ep of inv.endpoints.slice(0, 80)) {
    const id = `ep:${hashStr(ep.url + (ep.method ?? ""))}`;
    node({ id, type: "endpoint", label: `${ep.method ? ep.method + " " : ""}${ep.url.replace(/^https?:\/\/[^/]+/, "")}`, data: { url: ep.url, kind: ep.kind } });
    const a = assetByUrl.get(ep.foundIn);
    const p = pageByUrl.get(ep.foundIn.split("#")[0]!);
    if (a) edge(a.id, id, "calls");
    else if (p) edge(p.id, id, "calls");
  }
  if (extra) {
    for (const n of extra.nodes) node(n);
    for (const e of extra.edges) edges.set(e.id, e);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function pathLabel(url: string) {
  try {
    const u = new URL(url);
    return (u.pathname === "/" ? u.host : u.pathname) + (u.search ? "?…" : "");
  } catch {
    return url;
  }
}
