import { nodeAdapter } from "./adapter.js";
export default nodeAdapter(async () => new Response(JSON.stringify({ ok: true, mode: "hosted", service: "omniforge-re" }), { headers: { "content-type": "application/json", "cache-control": "no-store" } }));
