/**
 * MCP client transports and connection hub for the desktop engine, so OmniForge's OWN agents (Build plans) can use MCP tools.
 * Servers are the user's choice (validated by core's mcpServerProblem); stdio servers run as the user and are NOT sandboxed —
 * the UI says so before connecting. Remote servers must be https (or loopback http). OAuth-protected servers are not supported yet.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { McpClient, McpError, mcpServerProblem, toolFingerprint, type McpServerSpec, type McpTool, type McpTransport } from "@omniforge/core";
import { sanitizedEnv } from "./jobs.js";
import { nodeNet } from "../net.js";

type Msg = Record<string, unknown>;

/** Newline-delimited JSON-RPC over a child process's stdin/stdout. stderr is kept (last 4 KB) for error messages only. */
export function stdioTransport(spec: { command: string; args?: string[] }, o: { cwd?: string } = {}): McpTransport & { stderr(): string; child: ChildProcess } {
  const child = spawn(spec.command, spec.args ?? [], { cwd: o.cwd, env: sanitizedEnv(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  let cb: (m: Msg) => void = () => {}; let buf = ""; let err = ""; let exited: string | null = null; let onClose: (r: string) => void = () => {};
  const why = () => { const lines = err.trim().split("\n").map((l) => l.trim()).filter(Boolean); const key = lines.find((l) => /error/i.test(l)) ?? lines.at(-1); return `The MCP server ${exited}${key ? `: ${key.slice(0, 300)}` : ""}`; };
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => { buf += d; let i: number; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { cb(JSON.parse(line)); } catch { /* servers must not print non-JSON to stdout; ignore */ } } if (buf.length > 8_000_000) buf = ""; });
  child.stderr!.on("data", (d) => { err = (err + d.toString()).slice(-4000); });
  child.on("exit", (code, sig) => { exited = `exited (${sig ?? code})`; setTimeout(() => onClose(why()), 50); }); // let stderr drain first
  child.on("error", (e) => { exited = `could not start: ${e.message}`; onClose(why()); });
  child.stdin!.on("error", () => {});
  return {
    child, stderr: () => err,
    async send(m) { if (exited) throw new McpError(why()); child.stdin!.write(JSON.stringify(m) + "\n"); },
    onMessage(f) { cb = f; }, onClose(f) { onClose = f; },
    async close() { try { child.stdin!.end(); } catch { /* gone */ } const pid = child.pid; if (!pid) return; try { process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM"); } catch { /* gone */ } setTimeout(() => { try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch { /* gone */ } }, 2000).unref(); },
  };
}

/** Streamable HTTP transport (MCP 2025-03-26+): POST each message; the reply is JSON or an SSE stream; the session id is echoed back. */
export function httpTransport(url: string, o: { fetch?: typeof fetch } = {}): McpTransport {
  const loop = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//.test(url + "/");
  const f = o.fetch ?? (nodeNet({ allowPrivate: loop }).fetch as unknown as typeof fetch);
  let cb: (m: Msg) => void = () => {}; let session: string | undefined; let version: string | undefined; let ctrl = new AbortController();
  const deliver = (m: unknown) => { if (Array.isArray(m)) m.forEach((x) => cb(x as Msg)); else if (m && typeof m === "object") cb(m as Msg); };
  return {
    async send(m) {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      if (session) headers["mcp-session-id"] = session; if (version) headers["mcp-protocol-version"] = version;
      const res = await f(url, { method: "POST", headers, body: JSON.stringify(m), signal: ctrl.signal, redirect: "error" } as RequestInit);
      const sid = res.headers.get("mcp-session-id"); if (sid) session = sid;
      if (res.status === 202 || res.status === 204) return;
      if (res.status === 401 || res.status === 403) throw new McpError(`The MCP server requires sign-in (HTTP ${res.status}); OAuth-protected servers are not supported yet`);
      if (!res.ok) throw new McpError(`The MCP server answered HTTP ${res.status}`);
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream")) {
        const reader = res.body!.getReader(); const dec = new TextDecoder(); let acc = "";
        void (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; acc += dec.decode(value, { stream: true }); let i: number; while ((i = acc.search(/\r?\n\r?\n/)) >= 0) { const block = acc.slice(0, i); acc = acc.slice(i).replace(/^\r?\n\r?\n/, ""); const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n"); if (data) { try { deliver(JSON.parse(data)); } catch { /* ignore */ } } } } } catch { /* closed */ } })();
      } else {
        const text = await res.text(); if (text.trim()) { try { const j = JSON.parse(text); deliver(j); if ((j as Msg)?.result && typeof ((j as Msg).result as Msg).protocolVersion === "string") version = ((j as Msg).result as Msg).protocolVersion as string; } catch { throw new McpError("The MCP server sent invalid JSON"); } }
      }
    },
    onMessage(fn) { cb = (m) => { const r = (m as Msg).result as Msg | undefined; if (r && typeof r.protocolVersion === "string") version = r.protocolVersion; fn(m); }; },
    async close() { ctrl.abort(); ctrl = new AbortController(); if (session) { try { await f(url, { method: "DELETE", headers: { "mcp-session-id": session } }); } catch { /* best effort */ } } },
  };
}

export interface ConnectedServer { spec: McpServerSpec; key: string; client: McpClient; tools: (McpTool & { fingerprint: string })[]; serverInfo?: { name?: string; version?: string }; usedAt: number }
const keyOf = (s: McpServerSpec) => JSON.stringify("url" in s ? [s.name, s.url] : [s.name, s.command, s.args ?? []]);

/** Keeps connections open between agent tool calls; closes idle ones. */
export class McpHub {
  private conns = new Map<string, ConnectedServer>(); private timer: ReturnType<typeof setInterval>;
  constructor(private o: { idleMs?: number; transport?: (s: McpServerSpec) => McpTransport } = {}) { this.timer = setInterval(() => void this.sweep(), 60_000); this.timer.unref(); }
  async connect(spec: McpServerSpec): Promise<ConnectedServer> {
    const p = mcpServerProblem(spec); if (p) throw new McpError(`MCP server “${spec?.name}”: ${p}`);
    const key = keyOf(spec); const have = this.conns.get(key); if (have) { have.usedAt = Date.now(); return have; }
    const t = this.o.transport ? this.o.transport(spec) : "url" in spec ? httpTransport(spec.url) : stdioTransport(spec);
    const client = new McpClient(t, { timeoutMs: 120_000 });
    try { await client.initialize(); const list = await client.listTools(); const tools = await Promise.all(list.map(async (x) => ({ ...x, fingerprint: await toolFingerprint(x) })));
      const c: ConnectedServer = { spec, key, client, tools, serverInfo: client.serverInfo, usedAt: Date.now() }; this.conns.set(key, c); return c;
    } catch (e) { await client.close().catch(() => {}); throw e; }
  }
  async call(spec: McpServerSpec, tool: string, args: Record<string, unknown>) {
    const c = this.conns.get(keyOf(spec)); if (!c) throw new McpError(`Not connected to MCP server “${spec.name}”`);
    if (!c.tools.some((t) => t.name === tool)) throw new McpError(`MCP server “${spec.name}” has no tool “${tool}”`);
    c.usedAt = Date.now(); return c.client.callTool(tool, args ?? {}, 300_000);
  }
  async disconnect(spec: McpServerSpec) { const k = keyOf(spec); const c = this.conns.get(k); if (c) { this.conns.delete(k); await c.client.close().catch(() => {}); } }
  async sweep() { const idle = this.o.idleMs ?? 15 * 60_000; for (const c of [...this.conns.values()]) if (Date.now() - c.usedAt > idle) await this.disconnect(c.spec); }
  async closeAll() { clearInterval(this.timer); await Promise.all([...this.conns.values()].map((c) => this.disconnect(c.spec))); }
  get size() { return this.conns.size; }
}

/** Request bodies → specs (same shape the Agent CLI tab sends); validation happens in connect(). */
export const specFrom = (m: any): McpServerSpec => ("url" in (m ?? {}) ? { name: String(m.name), url: String(m.url) } : { name: String(m?.name), command: String(m?.command), args: Array.isArray(m?.args) ? m.args.map(String) : [] });
