#!/usr/bin/env node
/** Sidecar entry: `omniforge-bridge [--port N]` (or `omniforge-bridge mcp`). The desktop app reads the ready line on stdout. */
import { startBridge } from "./bridge/server.js";

// `omniforge-bridge mcp [--allow-private]`: serve OmniForge's read/plan tools to an MCP client over stdio instead of starting the bridge.
if (process.argv[2] === "mcp") {
  const { serveMcpStdio } = await import("./mcp-server.js");
  await serveMcpStdio({ version: process.env.OMNIFORGE_VERSION ?? "0.1.0", allowPrivate: process.argv.includes("--allow-private") });
  process.exit(0);
}

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const port = Number(arg("port") ?? process.env.OMNIFORGE_BRIDGE_PORT ?? 0);
const bridge = await startBridge({ port, uiToken: process.env.OMNIFORGE_UI_TOKEN, version: process.env.OMNIFORGE_VERSION ?? "0.1.0", allowedOrigins: (process.env.OMNIFORGE_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean) });
// One machine-readable line for the launcher (Tauri) — includes the app token.
console.log(JSON.stringify({ ready: true, port: bridge.port, url: bridge.url, uiToken: bridge.auth.uiToken }));
if (process.stdout.isTTY) { const c = bridge.auth.newPairingCode(); console.error(`\nOmniForge bridge listening on ${bridge.url}\nPairing code for the web app: ${c.code}  (valid 2 minutes)\n`); }
const stop = async () => { await bridge.close(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
// exit if the launcher dies (stdin closes)
if (!process.argv.includes("--no-stdin-watch")) { process.stdin.on("end", stop); process.stdin.resume(); }
