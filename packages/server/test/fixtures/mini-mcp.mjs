#!/usr/bin/env node
// A minimal MCP server over stdio (newline-delimited JSON-RPC), written from the protocol spec, used to prove an MCP tool really reaches the agent.
// One tool, `lookup`, returns a value only this process knows (first command-line argument), so the agent cannot guess it.
import readline from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const tools = [{ name: "lookup", description: "Look up the project code word. Always call this tool when asked for the code word.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: [] } }];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mini", version: "1.0.0" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  if (m.method === "tools/call") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: process.argv[2] ?? "unset" }] } });
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} }); // ping etc.
});
