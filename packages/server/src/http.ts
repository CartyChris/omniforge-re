/** Tiny helpers shared by the Vercel functions and the bridge HTTP server. */
export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

export const err = (message: string, status = 400, extra: Record<string, unknown> = {}) => json({ error: message, ...extra }, status);

/** Server-sent events response with a writer. The stream closes when `run` settles. */
export function sse(run: (send: (event: string, data: unknown) => void, signal: AbortSignal) => Promise<void>, req: Request): Response {
  const enc = new TextEncoder();
  const ctrl = new AbortController();
  req.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      let closed = false;
      const send = (event: string, data: unknown) => { if (!closed) { try { c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { closed = true; } } };
      const ping = setInterval(() => { if (!closed) { try { c.enqueue(enc.encode(": ping\n\n")); } catch { closed = true; } } }, 15_000);
      try { await run(send, ctrl.signal); } catch (e) { send("error", { message: (e as Error).message }); }
      finally { clearInterval(ping); closed = true; try { c.close(); } catch { /* already closed */ } }
    },
    cancel() { ctrl.abort(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no", connection: "keep-alive" } });
}

export async function readJson<T = any>(req: Request, maxBytes = 25_000_000): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new HttpError(413, "Request body too large");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request body too large");
  try { return JSON.parse(text || "{}"); } catch { throw new HttpError(400, "Body must be valid JSON"); }
}

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export const b64ToBytes = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "base64"));
export const bytesToB64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

/** An error whose message is safe and useful to show the user (mapped to HTTP 400). */
export class UserError extends Error { readonly status = 400; constructor(m: string) { super(m); this.name = "UserError"; } }
