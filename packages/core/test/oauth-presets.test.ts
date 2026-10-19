import { describe, expect, it } from "vitest";
import { exchangeOpenRouterCode, openRouterAuthUrl, pkcePair } from "../src/ai/oauth";
import { PRESETS, configFromPreset, createProvider } from "../src/ai/registry";

describe("OpenRouter sign-in (OAuth PKCE)", () => {
  it("creates a valid verifier and its S256 challenge", async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const want = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    expect(challenge).toBe(want);
    expect((await pkcePair()).verifier).not.toBe(verifier);
  });
  it("builds the authorisation URL and only allows https or localhost callbacks", () => {
    const u = new URL(openRouterAuthUrl("http://127.0.0.1:4466/bridge/oauth/openrouter/callback/abc", "CH"));
    expect(u.origin + u.pathname).toBe("https://openrouter.ai/auth");
    expect(Object.fromEntries(u.searchParams)).toEqual({ callback_url: "http://127.0.0.1:4466/bridge/oauth/openrouter/callback/abc", code_challenge: "CH", code_challenge_method: "S256" });
    expect(() => openRouterAuthUrl("http://evil.example/cb", "CH")).toThrow(/https/);
    expect(openRouterAuthUrl("https://app.example/", "CH")).toContain("callback_url=https%3A%2F%2Fapp.example%2F");
  });
  it("exchanges the code with exactly the documented request, and reports failures", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const ok = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ key: "sk-or-v1-abc" }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await exchangeOpenRouterCode("code123", "verif", { fetch: ok })).toBe("sk-or-v1-abc");
    expect(seen!.url).toBe("https://openrouter.ai/api/v1/auth/keys"); expect(seen!.init.method).toBe("POST");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ code: "code123", code_verifier: "verif", code_challenge_method: "S256" });
    const bad = (async () => new Response(JSON.stringify({ error: { message: "Invalid code" } }), { status: 403 })) as unknown as typeof fetch;
    await expect(exchangeOpenRouterCode("code123", "v", { fetch: bad })).rejects.toThrow(/HTTP 403\): Invalid code/);
    await expect(exchangeOpenRouterCode("code123", "v", { fetch: (async () => new Response("{}", { status: 200 })) as never })).rejects.toThrow(/did not return a key/);
    await expect(exchangeOpenRouterCode("bad code\n", "v", { fetch: ok })).rejects.toThrow(/invalid authorization code/);
  });
});

describe("provider presets", () => {
  it("have unique ids, https endpoints for cloud services, and no hard-coded model names", () => {
    const ids = PRESETS.map((p) => p.id); expect(new Set(ids).size).toBe(ids.length);
    for (const p of PRESETS.filter((x) => !x.local && x.id !== "custom")) expect(p.baseUrl, p.id).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/);
    for (const id of ["groq", "mistral", "deepseek", "together", "fireworks", "cerebras", "huggingface", "nvidia", "vercel-gateway"]) expect(ids, id).toContain(id);
  });
  it("OpenRouter calls carry app attribution headers and its own reasoning parameter; others use reasoning_effort", async () => {
    const reqs: { url: string; headers: Record<string, string>; body: any }[] = [];
    const f = (async (url: string, init: RequestInit) => { reqs.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) }); return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } }); }) as unknown as typeof fetch;
    for (const preset of ["openrouter", "openai"]) { const p = createProvider(configFromPreset(preset, { apiKey: "k" }), f); for await (const _ of p.chat({ model: "m", messages: [{ role: "user", content: "x" }], reasoning: "high" })) { /* drain */ } }
    expect(reqs[0]!.headers).toMatchObject({ "HTTP-Referer": "https://github.com/CartyChris/omniforge-re", "X-Title": "OmniForge RE" });
    expect(reqs[0]!.body.reasoning).toEqual({ effort: "high" }); expect(reqs[0]!.body.reasoning_effort).toBeUndefined();
    expect(reqs[1]!.body.reasoning_effort).toBe("high"); expect(reqs[1]!.headers["X-Title"]).toBeUndefined();
  });
});
