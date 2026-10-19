/**
 * Model Context Protocol CLIENT for OmniForge's own agents (transport-independent part).
 *
 * The desktop engine supplies the transport (stdio processes or Streamable HTTP; see packages/server/src/bridge/mcp.ts). This module does
 * the protocol (initialize → notifications/initialized → tools/list with pagination → tools/call), turns MCP tools into agent tool
 * definitions, and pins every tool's definition so a server that silently changes a tool's description or schema after it was approved
 * (a "rug pull", which the protocol itself cannot prevent) is caught and must be approved again.
 */
import { sha256 } from "../util/index.js";
import { untrusted } from "./untrusted.js";
import type { ToolDef } from "./types.js";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface McpTransport {
  /** Send one JSON-RPC message. */
  send(msg: Record<string, unknown>): Promise<void>;
  /** Receive messages (responses, notifications, server requests). */
  onMessage(cb: (msg: Record<string, unknown>) => void): void;
  close(): Promise<void>;
  /** Optional: the connection ended on its own (process exited, stream closed). Pending requests then fail at once instead of timing out. */
  onClose?(cb: (reason: string) => void): void;
}

export interface McpTool { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }
export interface McpCallResult { text: string; isError: boolean; structured?: unknown }

export class McpError extends Error { constructor(message: string, readonly code?: number) { super(message); this.name = "McpError"; } }

export class McpClient {
  private id = 0; private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  serverInfo?: { name?: string; version?: string }; protocolVersion?: string; instructions?: string; capabilities?: Record<string, unknown>;
  constructor(private t: McpTransport, private o: { timeoutMs?: number; clientName?: string; clientVersion?: string } = {}) {
    t.onMessage((m) => this.onMessage(m));
    t.onClose?.((reason) => { this.closedReason = reason; for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new McpError(reason)); } this.pending.clear(); });
  }
  private closedReason?: string;
  private onMessage(m: Record<string, any>) {
    if (m.id !== undefined && m.id !== null && (m.result !== undefined || m.error !== undefined) && typeof m.method !== "string") {
      const p = this.pending.get(Number(m.id)); if (!p) return; this.pending.delete(Number(m.id)); clearTimeout(p.timer);
      if (m.error) p.reject(new McpError(String(m.error.message ?? "MCP error"), m.error.code)); else p.resolve(m.result);
      return;
    }
    // Server → client requests we do not support (sampling, elicitation, roots): answer with "method not found" so the server is not left waiting.
    if (typeof m.method === "string" && m.id !== undefined && m.id !== null) {
      if (m.method === "ping") void this.t.send({ jsonrpc: "2.0", id: m.id, result: {} }).catch(() => {});
      else void this.t.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `OmniForge does not support ${m.method}` } }).catch(() => {});
    }
  }
  request<T = any>(method: string, params?: Record<string, unknown>, timeoutMs = this.o.timeoutMs ?? 60_000): Promise<T> {
    const id = ++this.id;
    if (this.closedReason) return Promise.reject(new McpError(this.closedReason));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new McpError(`MCP ${method} timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.t.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }).catch((e) => { clearTimeout(timer); this.pending.delete(id); reject(e instanceof Error ? e : new McpError(String(e))); });
    });
  }
  async initialize(): Promise<void> {
    const r = await this.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: this.o.clientName ?? "omniforge-re", version: this.o.clientVersion ?? "0.1.0" } }, 30_000);
    if (!r || typeof r !== "object") throw new McpError("The server sent an invalid initialize result");
    if (!MCP_PROTOCOL_VERSIONS.includes(r.protocolVersion)) throw new McpError(`The server speaks MCP protocol version ${String(r.protocolVersion)}, which OmniForge does not support (${MCP_PROTOCOL_VERSIONS.join(", ")})`);
    this.protocolVersion = r.protocolVersion; this.serverInfo = r.serverInfo; this.instructions = typeof r.instructions === "string" ? r.instructions : undefined; this.capabilities = r.capabilities ?? {};
    await this.t.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  async listTools(maxPages = 20): Promise<McpTool[]> {
    if (this.capabilities && !this.capabilities.tools) return [];
    const out: McpTool[] = []; let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const r = await this.request("tools/list", cursor ? { cursor } : undefined);
      for (const t of Array.isArray(r?.tools) ? r.tools : []) if (t && typeof t.name === "string" && t.name) out.push({ name: t.name, title: typeof t.title === "string" ? t.title : undefined, description: typeof t.description === "string" ? t.description : undefined, inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : undefined, annotations: t.annotations && typeof t.annotations === "object" ? t.annotations : undefined });
      cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined; if (!cursor) break;
    }
    return out;
  }
  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpCallResult> {
    const r = await this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
    const parts: string[] = [];
    for (const c of Array.isArray(r?.content) ? r.content : []) {
      if (c?.type === "text") parts.push(String(c.text ?? ""));
      else if (c?.type === "resource" && c.resource?.text) parts.push(String(c.resource.text));
      else if (c?.type === "resource_link") parts.push(`[resource] ${String(c.uri ?? "")}`);
      else if (c?.type) parts.push(`[${c.type} content omitted]`);
    }
    if (!parts.length && r?.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
    return { text: parts.join("\n"), isError: !!r?.isError, structured: r?.structuredContent };
  }
  async close() { for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new McpError("Connection closed")); } this.pending.clear(); await this.t.close(); }
}

/* ---------------- pinning ---------------- */

const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v ?? null);
/** Fingerprint of everything the model reads about a tool (name, title, description, schema, annotations). */
export const toolFingerprint = (t: McpTool) => sha256(canonical({ n: t.name, t: t.title ?? null, d: t.description ?? null, s: t.inputSchema ?? null, a: t.annotations ?? null }));

export interface PinDiff { added: string[]; changed: string[]; removed: string[]; same: string[] }
export function diffPins(pinned: Record<string, string> | undefined, current: Record<string, string>): PinDiff {
  const p = pinned ?? {}; const d: PinDiff = { added: [], changed: [], removed: [], same: [] };
  for (const [k, v] of Object.entries(current)) (p[k] === undefined ? d.added : p[k] === v ? d.same : d.changed).push(k);
  for (const k of Object.keys(p)) if (current[k] === undefined) d.removed.push(k);
  return d;
}

/* ---------------- agent tools ---------------- */

/** Function name an LLM may call for this MCP tool: providers accept ^[a-zA-Z0-9_-]{1,64}$. */
export function agentToolName(server: string, tool: string): string {
  const s = `mcp__${server}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  if (s.length <= 64) return s;
  let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } // FNV-1a keeps long names unique and stable
  return `${s.slice(0, 55)}_${h.toString(16).padStart(8, "0")}`;
}

/** Agent tool definition for an MCP tool. Descriptions come from a third party, so they are labelled as such and length-capped. */
export function mcpToolDef(server: string, t: McpTool): ToolDef {
  const desc = (t.description ?? t.title ?? "").replace(/\s+/g, " ").slice(0, 1200);
  const schema = t.inputSchema && (t.inputSchema as { type?: string }).type === "object" ? t.inputSchema : { type: "object", properties: {} };
  return { name: agentToolName(server, t.name), description: `[MCP server “${server}”, third-party tool “${t.name}”] ${desc}`.trim(), parameters: schema };
}

/** What the agent sees from a tool call: always fenced as untrusted data, because it comes from outside OmniForge. */
export function mcpResultForAgent(server: string, tool: string, r: McpCallResult, max = 40_000): string {
  return `${r.isError ? "The tool reported an error.\n" : ""}${untrusted(`mcp:${server}/${tool}`, r.text || "(empty result)", max)}`;
}
