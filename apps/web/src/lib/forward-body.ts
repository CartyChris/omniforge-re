/**
 * How a request body travels through the JSON forwarders (hosted /api/forward and the desktop /bridge/forward):
 * text as `body`, bytes (e.g. a Netlify ZIP) as `bodyBase64`. Anything else is refused loudly instead of being dropped.
 */
export function forwardBody(body: BodyInit | null | undefined): { body?: string; bodyBase64?: string } {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { body };
  const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : null;
  if (!bytes) throw new Error(`This request body type (${Object.prototype.toString.call(body)}) cannot be forwarded — send a string or bytes.`);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { bodyBase64: btoa(s) };
}
