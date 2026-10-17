/** Local stand-in for the Vercel functions: serves /api/* with the same portable handlers. */
import http from "node:http";
import { nodeAdapter } from "./vercel/adapter.js";
import { analyzeHandler, forwardHandler, probeHandler, repoFilesHandler, repoInspectHandler, type Mode } from "./handlers.js";

const mode: Mode = process.env.OMNIFORGE_DEV_LOCAL === "1" ? "local" : "hosted";
const port = Number(process.env.PORT ?? 8787);
const routes: Record<string, (r: Request) => Promise<Response>> = {
  "/api/analyze": (r) => analyzeHandler(r, { mode }),
  "/api/repo/inspect": (r) => repoInspectHandler(r, { mode }),
  "/api/repo/files": (r) => repoFilesHandler(r, { mode }),
  "/api/forward": (r) => forwardHandler(r, { mode }),
  "/api/probe": (r) => probeHandler(r, { mode }),
  "/api/health": async () => new Response(JSON.stringify({ ok: true, mode }), { headers: { "content-type": "application/json" } }),
};

http.createServer((nreq, nres) => {
  const url = new URL(nreq.url ?? "/", `http://${nreq.headers.host}`);
  const h = routes[url.pathname];
  if (!h) { nres.writeHead(404, { "content-type": "application/json" }); return void nres.end('{"error":"Not found"}'); }
  nodeAdapter(h)(nreq, nres);
}).listen(port, "127.0.0.1", () => console.log(`[omniforge dev api] ${mode} mode on http://127.0.0.1:${port}`));
