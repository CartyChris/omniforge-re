/** Local stand-in for the Vercel functions: serves /api/* with the same portable handlers. */
import http from "node:http";
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
  const chunks: Buffer[] = [];
  nreq.on("data", (c) => chunks.push(c));
  nreq.on("end", async () => {
    const url = new URL(nreq.url ?? "/", `http://${nreq.headers.host}`);
    const h = routes[url.pathname];
    if (!h) { nres.writeHead(404, { "content-type": "application/json" }); return void nres.end('{"error":"Not found"}'); }
    const ctrl = new AbortController(); nres.on("close", () => { if (!nres.writableFinished) ctrl.abort(); });
    const headers = new Headers(); for (const [k, v] of Object.entries(nreq.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const body = nreq.method === "GET" || nreq.method === "HEAD" ? undefined : Buffer.concat(chunks);
    let res: Response;
    try { res = await h(new Request(url, { method: nreq.method, headers, body, signal: ctrl.signal })); } catch (e) { res = new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 }); }
    const out: Record<string, string> = {}; res.headers.forEach((v, k) => (out[k] = v));
    nres.writeHead(res.status, out);
    if (!res.body) return void nres.end();
    const reader = res.body.getReader();
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; if (!nres.write(value)) await new Promise((r) => nres.once("drain", r)); } } catch { /* client left */ } finally { nres.end(); }
  });
}).listen(port, "127.0.0.1", () => console.log(`[omniforge dev api] ${mode} mode on http://127.0.0.1:${port}`));
