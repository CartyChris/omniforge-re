/**
 * MCP servers for OmniForge's own Build agents (desktop engine only). The same server list as the Agent CLI tab.
 * Every server's tools are pinned on first approval; new or changed tools (a possible rug pull) need approval again.
 */
import { MCP_PRESETS, agentToolName, describeMcpServer, diffPins, mcpResultForAgent, mcpServerProblem, mcpToolDef, type McpServerSpec, type McpTool, type ToolDef } from "@omniforge/core";
import { db } from "./storage";
import { useApp } from "./store";
import { requestApproval } from "./approvals";
import { audit } from "./audit";

const DEFS = "agent:mcp"; const ENABLED = "mcp:agents"; const PINS = "mcp:pins";
export type RemoteTool = McpTool & { fingerprint: string };
export interface ConnectResult { name: string; ok: boolean; error?: string; serverInfo?: { name?: string; version?: string }; tools?: RemoteTool[] }

export async function mcpServers(): Promise<McpServerSpec[]> {
  const custom = ((await db.get<McpServerSpec[]>(DEFS)) ?? []).filter((d) => !mcpServerProblem(d));
  return [...MCP_PRESETS.map((p) => p.server), ...custom.filter((d) => !MCP_PRESETS.some((p) => p.server.name === d.name))];
}
export async function agentMcpEnabled(): Promise<string[]> { return (await db.get<string[]>(ENABLED)) ?? []; }
export async function setAgentMcpEnabled(name: string, on: boolean) { const s = new Set(await agentMcpEnabled()); on ? s.add(name) : s.delete(name); await db.set(ENABLED, [...s]); void audit(on ? "MCP server enabled for agents" : "MCP server disabled for agents", name); }
const pinKey = (s: McpServerSpec) => describeMcpServer(s);
export async function pinsFor(s: McpServerSpec): Promise<Record<string, string> | undefined> { return (await db.get<Record<string, Record<string, string>>>(PINS))?.[pinKey(s)]; }
async function savePins(s: McpServerSpec, tools: RemoteTool[]) { const all = (await db.get<Record<string, Record<string, string>>>(PINS)) ?? {}; all[pinKey(s)] = Object.fromEntries(tools.map((t) => [t.name, t.fingerprint])); await db.set(PINS, all); }

export async function connectMcp(servers: McpServerSpec[]): Promise<ConnectResult[]> {
  const b = useApp.getState().bridge; if (!b || useApp.getState().bridgeState !== "connected") throw new Error("MCP servers need the desktop app.");
  return (await b.post<{ servers: ConnectResult[] }>("/bridge/mcp/connect", { servers })).servers;
}

/**
 * Agent tools for the enabled servers. Connecting starts stdio servers on this Mac, so a server whose tools are new or have changed
 * since they were last approved is shown to the user first (exact command, every new/changed tool); a declined server is left out.
 */
export async function mcpAgentTools(log?: (line: string) => void): Promise<Record<string, { def: ToolDef; run: (args: any) => Promise<string> }>> {
  const enabled = await agentMcpEnabled(); if (!enabled.length) return {};
  const b = useApp.getState().bridge; if (!b || useApp.getState().bridgeState !== "connected") { log?.("MCP servers are enabled but need the desktop app; continuing without them"); return {}; }
  const specs = (await mcpServers()).filter((s) => enabled.includes(s.name));
  const out: Record<string, { def: ToolDef; run: (args: any) => Promise<string> }> = {};
  for (const r of await connectMcp(specs)) {
    const spec = specs.find((s) => s.name === r.name)!;
    if (!r.ok || !r.tools) { log?.(`MCP server ${r.name} unavailable: ${r.error}`); continue; }
    const d = diffPins(await pinsFor(spec), Object.fromEntries(r.tools.map((t) => [t.name, t.fingerprint])));
    if (d.added.length || d.changed.length) {
      const first = !d.same.length && !d.changed.length && !d.removed.length;
      const ok = await requestApproval({ kind: "command", danger: true, title: first ? `Let Build agents use the MCP server “${r.name}”?` : `MCP server “${r.name}” changed its tools`, command: describeMcpServer(spec).replace(/^[^:]+: /, ""),
        detail: `${first ? "This server runs on your Mac as you (not sandboxed) or is a web service that receives what the agent sends. " : "Tool definitions differ from the ones you approved — review before continuing. "}${d.changed.length ? `Changed: ${d.changed.join(", ")}. ` : ""}${d.added.length ? `New: ${d.added.join(", ")}. ` : ""}${d.removed.length ? `Removed: ${d.removed.join(", ")}.` : ""}` });
      if (!ok) { log?.(`MCP server ${r.name} not approved; continuing without it`); continue; }
      await savePins(spec, r.tools); void audit("MCP tools approved", `${r.name}: ${r.tools.map((t) => t.name).join(", ")}`);
    }
    for (const t of r.tools) {
      const def = mcpToolDef(spec.name, t);
      out[agentToolName(spec.name, t.name)] = { def, run: async (args) => { try { return mcpResultForAgent(spec.name, t.name, await b.post("/bridge/mcp/call", { server: spec, tool: t.name, args: args ?? {} })); } catch (e) { return `Error: ${(e as Error).message}`; } } };
    }
  }
  return out;
}
