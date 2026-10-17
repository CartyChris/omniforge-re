/** Node (req, res) ⇄ Web Request/Response adapter shared by the Vercel functions and the local dev API. Streams responses (SSE/NDJSON). */
import type { IncomingMessage, ServerResponse } from "node:http";

export type WebHandler = (req: Request) => Promise<Response>;
const MAX_BODY = 40_000_000;

export function nodeAdapter(h: WebHandler) {
  return (nreq: IncomingMessage, nres: ServerResponse): void => {
    const chunks: Buffer[] = []; let size = 0; let tooBig = false;
    nreq.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) tooBig = true; else chunks.push(c); });
    nreq.on("end", async () => {
      const send = (status: number, body: string, headers: Record<string, string> = { "content-type": "application/json" }) => { nres.writeHead(status, headers); nres.end(body); };
      if (tooBig) return send(413, '{"error":"Request too large"}');
      const proto = (nreq.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http";
      const url = new URL(nreq.url ?? "/", `${proto}://${nreq.headers.host ?? "localhost"}`);
      const headers = new Headers(); for (const [k, v] of Object.entries(nreq.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const ctrl = new AbortController(); nres.on("close", () => { if (!nres.writableFinished) ctrl.abort(); });
      let res: Response;
      try { res = await h(new Request(url, { method: nreq.method, headers, body: nreq.method === "GET" || nreq.method === "HEAD" ? undefined : Buffer.concat(chunks), signal: ctrl.signal })); }
      catch (e) { return send(500, JSON.stringify({ error: (e as Error).message })); }
      const out: Record<string, string> = {}; res.headers.forEach((v, k) => (out[k] = v));
      nres.writeHead(res.status, out);
      if (!res.body) return void nres.end();
      const reader = res.body.getReader();
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; if (!nres.write(value)) await new Promise((r) => nres.once("drain", r)); } } catch { /* client left */ } finally { nres.end(); reader.cancel().catch(() => {}); }
    });
  };
}
