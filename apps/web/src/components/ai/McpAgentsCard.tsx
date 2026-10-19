import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plug } from "lucide-react";
import { MCP_PRESETS, describeMcpServer, diffPins, mcpServerProblem, type McpServerSpec } from "@omniforge/core";
import { agentMcpEnabled, connectMcp, mcpServers, pinsFor, setAgentMcpEnabled, type ConnectResult } from "@/lib/mcp";
import { db } from "@/lib/storage";
import { useApp } from "@/lib/store";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlay";

/** MCP servers for OmniForge's own Build agents (desktop). Tools are pinned when first approved; changes need approval again. */
export function McpAgentsCard() {
  const connected = useApp((s) => s.bridgeState === "connected");
  const [servers, setServers] = useState<McpServerSpec[]>([]); const [on, setOn] = useState<string[]>([]); const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ConnectResult & { pin?: string }>>({}); const [form, setForm] = useState({ name: "", target: "" });
  const refresh = async () => { setServers(await mcpServers()); setOn(await agentMcpEnabled()); };
  useEffect(() => { void refresh(); }, []);
  const add = async () => {
    const name = form.name.trim(); const t = form.target.trim(); if (!name || !t) return;
    const spec: McpServerSpec = /^https?:\/\//i.test(t) ? { name, url: t } : { name, command: t.split(/\s+/)[0]!, args: t.split(/\s+/).slice(1) };
    const p = mcpServerProblem(spec); if (p) return void toast.error(p);
    if (servers.some((s) => s.name === name)) return void toast.error("A server with that name already exists.");
    await db.set("agent:mcp", [...((await db.get<McpServerSpec[]>("agent:mcp")) ?? []), spec]); setForm({ name: "", target: "" }); await refresh();
  };
  const test = async (s: McpServerSpec) => {
    setBusy(s.name);
    try { const [r] = await connectMcp([s]); const d = r?.tools ? diffPins(await pinsFor(s), Object.fromEntries(r.tools.map((t) => [t.name, t.fingerprint]))) : undefined;
      setResults((x) => ({ ...x, [s.name]: { ...r!, pin: d ? (d.added.length || d.changed.length ? (d.same.length || d.changed.length ? "changed since approval" : "not approved yet") : "approved") : undefined } }));
    } catch (e) { setResults((x) => ({ ...x, [s.name]: { name: s.name, ok: false, error: (e as Error).message } })); } finally { setBusy(null); }
  };
  return (
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Plug className="size-4" />MCP tools for Build agents</CardTitle>{!connected && <Badge>desktop app</Badge>}</CardHeader>
      <CardBody className="space-y-3 text-[13px]">
        <p className="text-muted">Give OmniForge's own agents tools from MCP servers. A server runs on your Mac as you (not sandboxed) or is a web service that receives what the agent sends. You approve each server's tools the first time, and again whenever a tool's definition changes. Results are treated as untrusted data.</p>
        <ul className="divide-y divide-line rounded-lg border border-line" data-testid="mcp-agent-servers">{servers.map((s) => { const preset = MCP_PRESETS.find((p) => p.server.name === s.name); const r = results[s.name]; return (
          <li key={s.name} className="space-y-1.5 px-3 py-2.5">
            <div className="flex items-center gap-2"><span className="font-medium">{preset?.label ?? s.name}</span><span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={describeMcpServer(s)}>{describeMcpServer(s).replace(/^[^:]+: /, "")}</span>
              <Button size="xs" variant="ghost" loading={busy === s.name} disabled={!connected} onClick={() => void test(s)}>Connect</Button>
              <Switch aria-label={`Use ${s.name} in Build agents`} checked={on.includes(s.name)} disabled={!connected} onCheckedChange={(v: boolean) => void setAgentMcpEnabled(s.name, v).then(refresh)} /></div>
            {r && (r.ok ? <p className="text-xs text-muted" data-testid={`mcp-result-${s.name}`}>{r.serverInfo?.name ?? s.name} {r.serverInfo?.version ?? ""} · {r.tools?.length ?? 0} tool(s): {r.tools?.map((t) => t.name).join(", ")} · <span className={r.pin === "approved" ? "text-ok" : "text-warn"}>{r.pin}</span></p> : <p className="text-xs text-bad" data-testid={`mcp-result-${s.name}`}>{r.error}</p>)}
          </li>); })}</ul>
        <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="name" aria-label="New MCP server name" /><Input value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="command and arguments, or an https:// address" aria-label="New MCP server command or address" /><Button size="sm" variant="secondary" onClick={() => void add()}>Add server</Button></div>
      </CardBody></Card>
  );
}
