import http from "node:http";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { McpHub, httpTransport, stdioTransport } from "../src/bridge/mcp";
import { McpClient } from "@omniforge/core";

const MINI = path.join(__dirname, "fixtures/mini-mcp.mjs");
const TSX = path.join(__dirname, "../node_modules/.bin/tsx"); const MAIN = path.join(__dirname, "../src/main.ts");
const hub = new McpHub();
afterAll(async () => { await hub.closeAll(); });

describe("stdio MCP servers (real processes)", () => {
  it("connects to a minimal server, pins its tools and calls one", async () => {
    const spec = { name: "mini", command: process.execPath, args: [MINI, "codeword-42"] };
    const c = await hub.connect(spec);
    expect(c.serverInfo).toMatchObject({ name: "mini" });
    expect(c.tools.map((t) => t.name)).toEqual(["lookup"]); expect(c.tools[0]!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await hub.call(spec, "lookup", {})).toMatchObject({ text: "codeword-42", isError: false });
    expect((await hub.connect(spec)).client).toBe(c.client); // reused, not respawned
    await expect(hub.call(spec, "nope", {})).rejects.toThrow(/has no tool/);
  }, 30_000);
  it("drives OmniForge's own MCP server (dogfood): read/plan tools, and its URL guard still applies", async () => {
    const spec = { name: "omniforge", command: TSX, args: [MAIN, "mcp"] };
    const c = await hub.connect(spec);
    expect(c.tools.map((t) => t.name)).toEqual(["analyze_url", "list_investigations", "get_investigation", "rebuild_plan"]);
    const r = await hub.call(spec, "analyze_url", { url: "http://169.254.169.254/latest/meta-data/" });
    expect(r.isError).toBe(true); expect(r.text).toMatch(/Refused/);
  }, 60_000);
  it("reports a server that dies on start with its stderr, and refuses unsafe launchers before spawning", async () => {
    await expect(hub.connect({ name: "dies", command: process.execPath, args: [path.join(__dirname, "fixtures/does-not-exist.mjs")] })).rejects.toThrow(/exited \(1\).*Cannot find module/);
    await expect(hub.connect({ name: "evil", command: "bash", args: ["-c", "id"] })).rejects.toThrow(/cannot be used to launch/);
    await expect(hub.connect({ name: "Bad_Name", command: "npx" })).rejects.toThrow(/Server names/);
  }, 10_000);
  it("closing kills the server process", async () => {
    const t = stdioTransport({ command: process.execPath, args: [MINI, "x"] }); const c = new McpClient(t); await c.initialize(); const pid = t.child.pid!;
    await c.close(); await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);
});

/** A Streamable HTTP MCP server in the two reply styles the spec allows. */
function httpServer(mode: "json" | "sse" | "auth") {
  const seen: { headers: http.IncomingHttpHeaders; body: any }[] = [];
  const srv = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c; const body = raw ? JSON.parse(raw) : null; seen.push({ headers: req.headers, body });
    if (req.method === "DELETE") { res.writeHead(204); return res.end(); }
    if (mode === "auth") { res.writeHead(401); return res.end(); }
    if (body?.id === undefined) { res.writeHead(202); return res.end(); }
    const result = body.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `h-${mode}` } }
      : body.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object", properties: { s: { type: "string" } } } }] }
      : { content: [{ type: "text", text: `echo:${body.params.arguments.s}` }] };
    const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    if (mode === "sse") { res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" }); res.write(`event: message\ndata: ${msg}\n\n`); return res.end(); }
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" }); res.end(msg);
  });
  return { srv, seen, listen: () => new Promise<string>((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(srv.address() as { port: number }).port}/mcp`))) };
}

describe("Streamable HTTP MCP servers", () => {
  for (const mode of ["json", "sse"] as const) it(`works when the server replies with ${mode === "json" ? "JSON" : "an SSE stream"}, echoing the session id and protocol version`, async () => {
    const s = httpServer(mode); const url = await s.listen();
    try {
      const c = new McpClient(httpTransport(url)); await c.initialize();
      expect((await c.listTools()).map((t) => t.name)).toEqual(["echo"]);
      expect(await c.callTool("echo", { s: "hi" })).toMatchObject({ text: "echo:hi" });
      const later = s.seen.filter((x) => x.body?.method === "tools/list")[0]!;
      expect(later.headers["mcp-session-id"]).toBe("sess-1"); expect(later.headers["mcp-protocol-version"]).toBe("2025-06-18");
      expect(s.seen[0]!.headers.accept).toBe("application/json, text/event-stream");
      await c.close(); expect(s.seen.some((x) => x.body === null && x.headers["mcp-session-id"] === "sess-1")).toBe(true); // DELETE ends the session
    } finally { s.srv.close(); }
  });
  it("says plainly that OAuth-protected servers are not supported", async () => {
    const s = httpServer("auth"); const url = await s.listen();
    try { await expect(new McpClient(httpTransport(url)).initialize()).rejects.toThrow(/requires sign-in.*not supported/); } finally { s.srv.close(); }
  });
});
