import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/ai/providers/anthropic";
import { OllamaProvider } from "../src/ai/providers/ollama";
import { OpenAICompatProvider } from "../src/ai/providers/openai";
import { configFromPreset, createProvider, discoverLocalServices, governed, UsageMeter, PRESETS } from "../src/ai/registry";
import { chooseModel, fitsMemory, recommendForAll } from "../src/ai/router";
import { estimateMemoryGB, guessCapabilities, parseParamsB, tierOf, finalize } from "../src/ai/models";
import { collect, ProviderError, type ChatRequest, type ModelInfo } from "../src/ai/types";

/** Mock servers speak the real wire formats (SSE / NDJSON) as documented by each vendor. */
let srv: http.Server;
let base: string;
const seen: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];

const sse = (res: http.ServerResponse, events: (string | object)[], named?: string[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  events.forEach((e, i) => res.write(`${named?.[i] ? `event: ${named[i]}\n` : ""}data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`));
  res.end();
};

beforeAll(async () => {
  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ url: req.url!, headers: req.headers, body });
      const u = req.url!;
      /* ---------- OpenAI-compatible ---------- */
      if (u === "/oa/v1/models") {
        if (req.headers.authorization !== "Bearer good-key") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Incorrect API key" } })); }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "gpt-x-mini" }, { id: "qwen2.5-coder-7b-instruct", context_length: 32768 }, { id: "text-embedding-3-small" }, { id: "vendor/vision-llama-90b", name: "Vision Llama", context_length: 128000, pricing: { prompt: "0.000002", completion: "0.000006" }, architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools", "reasoning"] }] }));
      }
      if (u === "/oa/v1/chat/completions") {
        if (body.messages.at(-1).content === "tools") {
          return sse(res, [
            { choices: [{ delta: { role: "assistant", content: "Let me write that." } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "write_file", arguments: '{"path":"a.' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ts","content":"x"}' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "list_files", arguments: "{}" } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
            "[DONE]",
          ]);
        }
        if (body.messages.at(-1).content === "boom") { res.writeHead(500, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "upstream exploded" } })); }
        return sse(res, [
          { choices: [{ delta: { reasoning_content: "hmm" } }] },
          { choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: { content: "lo" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }, "[DONE]",
        ]);
      }
      if (u === "/oa/v1/embeddings") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })); }
      /* ---------- Anthropic ---------- */
      if (u.startsWith("/an/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "claude-test-1", display_name: "Claude Test", created_at: "2026-01-01T00:00:00Z" }], has_more: false, last_id: "claude-test-1" }));
      }
      if (u === "/an/v1/messages") {
        if (body.messages.at(-1).content[0].text === "tools") {
          return sse(res, [
            { type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 1 } } },
            { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Calling" } },
            { type: "content_block_stop", index: 1 },
            { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "write_file", input: {} } },
            { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"b' } },
            { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '.ts"}' } },
            { type: "content_block_stop", index: 2 },
            { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 33 } },
            { type: "message_stop" },
          ]);
        }
        return sse(res, [
          { type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi " } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
          { type: "message_stop" },
        ]);
      }
      /* ---------- Ollama ---------- */
      if (u === "/ol/api/version") { res.writeHead(200); return res.end(JSON.stringify({ version: "0.9.9-test" })); }
      if (u === "/ol/api/tags") { res.writeHead(200); return res.end(JSON.stringify({ models: [{ name: "llama3.2:3b", size: 2019393189, modified_at: "2025-05-04T17:37:44Z", details: { family: "llama", parameter_size: "3.2B", quantization_level: "Q4_K_M" } }, { name: "nomic-embed-text:latest", size: 274302450, details: { family: "nomic-bert", parameter_size: "137M", quantization_level: "F16" } }] })); }
      if (u === "/ol/api/ps") { res.writeHead(200); return res.end(JSON.stringify({ models: [{ name: "llama3.2:3b" }] })); }
      if (u === "/ol/api/show") {
        res.writeHead(200);
        return res.end(JSON.stringify(body.model.startsWith("nomic") ? { capabilities: ["embedding"], model_info: { "nomic-bert.context_length": 2048 }, details: {} } : { capabilities: ["completion", "tools", "vision"], model_info: { "llama.context_length": 131072, "general.parameter_count": 3212749888 }, details: {} }));
      }
      if (u === "/ol/api/chat") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const lines = body.messages.at(-1).content === "tools"
          ? [{ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "get_weather", arguments: { city: "Tokyo" } } }] }, done: false }, { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 26, eval_count: 12 }]
          : [{ message: { role: "assistant", content: "Hel" }, done: false }, { message: { role: "assistant", content: "lo" }, done: false }, { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 4, eval_count: 2 }];
        return res.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      }
      if (u === "/ol/api/embed") { res.writeHead(200); return res.end(JSON.stringify({ embeddings: [[0.1, 0.2]] })); }
      res.writeHead(404); res.end("nope");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

const req = (content: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({ model: "m", messages: [{ role: "user", content }], ...extra });

describe("OpenAI-compatible adapter", () => {
  const mk = (key = "good-key") => new OpenAICompatProvider(configFromPreset("custom", { id: "oa", baseUrl: `${base}/oa/v1`, apiKey: key, label: "OA" }));
  it("discovers models, reporting context/pricing/capabilities only where the server gave them", async () => {
    const ms = await mk().listModels();
    expect(ms.map((m) => m.id)).toEqual(["gpt-x-mini", "qwen2.5-coder-7b-instruct", "text-embedding-3-small", "vendor/vision-llama-90b"]);
    const v = ms.find((m) => m.id === "vendor/vision-llama-90b")!;
    expect(v).toMatchObject({ contextWindow: 128000, capabilitySource: "reported", paramsB: 90 });
    expect(v.capabilities).toEqual(expect.arrayContaining(["vision", "tools", "reasoning"]));
    expect(v.pricePerMTok!.input).toBeCloseTo(2);
    expect(ms.find((m) => m.id === "qwen2.5-coder-7b-instruct")).toMatchObject({ paramsB: 7, capabilitySource: "heuristic" });
    expect(ms.find((m) => m.id === "text-embedding-3-small")!.capabilities).toEqual(["embeddings"]);
  });
  it("streams text + thinking + usage", async () => {
    const r = await collect(mk().chat(req("hi")));
    expect(r).toMatchObject({ text: "Hello", thinking: "hmm", finish: "stop", usage: { input: 5, output: 2 } });
    const sent = seen.filter((s) => s.url === "/oa/v1/chat/completions").at(-1)!;
    expect(sent.headers.authorization).toBe("Bearer good-key");
    expect(sent.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });
  it("reassembles tool calls streamed in fragments, in order", async () => {
    const r = await collect(mk().chat(req("tools", { tools: [{ name: "write_file", description: "", parameters: { type: "object" } }] })));
    expect(r.toolCalls).toEqual([{ id: "call_a", name: "write_file", args: { path: "a.ts", content: "x" } }, { id: "call_b", name: "list_files", args: {} }]);
    expect(r.finish).toBe("tool_calls");
  });
  it("embeds and restores input order", async () => expect(await mk().embed!("e", ["a", "b"])).toEqual([[1, 0], [0, 1]]));
  it("surfaces the real HTTP error, and never leaks the API key", async () => {
    const err = await mk("sk-supersecretkey1234567890").listModels().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/Incorrect API key/);
    expect(err.message).not.toMatch(/supersecretkey/);
    await expect(collect(mk().chat(req("boom")))).rejects.toThrow(/upstream exploded/);
  });
  it("reports connection failures with an actionable message", async () => {
    const dead = new OpenAICompatProvider(configFromPreset("lmstudio", { baseUrl: "http://127.0.0.1:9/v1" }));
    const h = await dead.health();
    expect(h.ok).toBe(false);
    expect(h.error).toMatch(/Cannot reach LM Studio.*Is the service running/);
  });
});

describe("Anthropic adapter", () => {
  const mk = () => new AnthropicProvider(configFromPreset("anthropic", { id: "an", baseUrl: `${base}/an/v1`, apiKey: "ant-key" }));
  it("lists models from the API (nothing hardcoded)", async () => expect((await mk().listModels()).map((m) => m.id)).toEqual(["claude-test-1"]));
  it("streams text and usage; sends required headers", async () => {
    const r = await collect(mk().chat(req("hi", { system: "be brief" })));
    expect(r).toMatchObject({ text: "Hi there", finish: "stop", usage: { input: 9, output: 4 } });
    const sent = seen.filter((s) => s.url === "/an/v1/messages").at(-1)!;
    expect(sent.headers["x-api-key"]).toBe("ant-key");
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent.body).toMatchObject({ system: "be brief", stream: true, max_tokens: 8192 });
  });
  it("assembles tool_use blocks from input_json_delta and reports thinking", async () => {
    const r = await collect(mk().chat(req("tools", { tools: [{ name: "write_file", description: "d", parameters: { type: "object" } }] })));
    expect(r.toolCalls).toEqual([{ id: "toolu_1", name: "write_file", args: { path: "b.ts" } }]);
    expect(r).toMatchObject({ thinking: "plan", text: "Calling", finish: "tool_calls", usage: { input: 20, output: 33 } });
    expect(seen.filter((s) => s.url === "/an/v1/messages").at(-1)!.body.tools[0]).toEqual({ name: "write_file", description: "d", input_schema: { type: "object" } });
  });
  it("converts tool results into user tool_result blocks and merges adjacent turns", async () => {
    await collect(mk().chat({ model: "m", messages: [{ role: "user", content: "go" }, { role: "assistant", content: "ok", toolCalls: [{ id: "t1", name: "x", args: { a: 1 } }] }, { role: "tool", toolCallId: "t1", content: "result" }] }));
    const msgs = seen.filter((s) => s.url === "/an/v1/messages").at(-1)!.body.messages;
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1].content.map((c: any) => c.type)).toEqual(["text", "tool_use"]);
    expect(msgs[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: "result" });
  });
});

describe("Ollama adapter", () => {
  const mk = () => new OllamaProvider(configFromPreset("ollama", { id: "ol", baseUrl: `${base}/ol` }));
  it("lists models with metadata from /api/tags + /api/show + /api/ps", async () => {
    const ms = await mk().listModels();
    const l = ms.find((m) => m.id === "llama3.2:3b")!;
    expect(l).toMatchObject({ contextWindow: 131072, quantization: "Q4_K_M", loaded: true, local: true, capabilitySource: "reported" });
    expect(l.paramsB).toBeCloseTo(3.2, 1);
    expect(l.capabilities).toEqual(expect.arrayContaining(["chat", "tools", "vision"]));
    expect(l.memoryGB).toBeGreaterThan(2);
    const e = ms.find((m) => m.id.startsWith("nomic"))!;
    expect(e.capabilities).toEqual(["embeddings"]);
    expect(tierOf(e)).toBe("embedding");
  });
  it("streams NDJSON chat with usage", async () => {
    const r = await collect(mk().chat(req("hi")));
    expect(r).toMatchObject({ text: "Hello", finish: "stop", usage: { input: 4, output: 2 } });
  });
  it("parses tool calls (arguments as objects)", async () => {
    const r = await collect(mk().chat(req("tools", { tools: [{ name: "get_weather", description: "", parameters: { type: "object" } }] })));
    expect(r.toolCalls).toMatchObject([{ name: "get_weather", args: { city: "Tokyo" } }]);
    expect(r.finish).toBe("tool_calls");
  });
  it("embeds, reports health with version", async () => {
    expect(await mk().embed!("nomic-embed-text", ["x"])).toEqual([[0.1, 0.2]]);
    expect(await mk().health()).toMatchObject({ ok: true, version: "0.9.9-test", models: 2 });
  });
});

describe("registry, governance, discovery", () => {
  it("has presets for every provider named in the spec and no model lists", () => {
    for (const id of ["anthropic", "openai", "gemini", "xai", "moonshot", "openrouter", "ollama", "lmstudio", "llamacpp", "mlx", "unsloth"]) expect(PRESETS.find((p) => p.id === id), id).toBeTruthy();
    expect(JSON.stringify(PRESETS)).not.toMatch(/gpt-4|claude-3|gemini-1|llama-3/i);
  });
  it("enforces cost limits", async () => {
    const cfg = configFromPreset("custom", { id: "oa", baseUrl: `${base}/oa/v1`, apiKey: "good-key", maxCostUsd: 0.000001, prices: { m: { input: 1000, output: 1000 } } });
    const meter = new UsageMeter();
    const p = governed(createProvider(cfg), { cfg, meter });
    await collect(p.chat(req("hi")));
    expect(meter.costUsd).toBeGreaterThan(0.000001);
    await expect(collect(p.chat(req("hi")))).rejects.toThrow(/Cost limit/);
  });
  it("falls back to the secondary provider only before anything was emitted", async () => {
    const bad = configFromPreset("custom", { id: "bad", baseUrl: "http://127.0.0.1:9/v1", label: "Bad" });
    const good = createProvider(configFromPreset("custom", { id: "oa", baseUrl: `${base}/oa/v1`, apiKey: "good-key" }));
    const p = governed(createProvider(bad), { cfg: bad, meter: new UsageMeter(), fallback: good });
    const r = await collect(p.chat(req("hi")));
    expect(r.text).toBe("Hello");
    expect(r.thinking).toMatch(/falling back/);
  });
  it("discovers only services that actually answer", async () => {
    const found = await discoverLocalServices(globalThis.fetch, undefined, [
      { presetId: "ollama", baseUrl: `${base}/ol`, kind: "ollama" },
      { presetId: "lmstudio", baseUrl: "http://127.0.0.1:9/v1", kind: "openai-compat" },
      { presetId: "unsloth", baseUrl: `${base}/oa/v1`, kind: "openai-compat" },
    ]);
    expect(found.map((f) => f.status)).toEqual(["reachable", "unreachable", "needs-auth"]);
    expect(found[0]).toMatchObject({ models: 2, version: "0.9.9-test" });
    expect(found[1]!.detail).toMatch(/Cannot reach/);
  });
});

describe("model metadata + routing", () => {
  it("parses parameter counts and estimates memory", () => {
    expect(parseParamsB("llama3.1:70b-instruct-q4_K_M")).toBe(70);
    expect(parseParamsB("mixtral-8x7b")).toBe(56);
    expect(parseParamsB("gemma-270m")).toBeCloseTo(0.27);
    expect(parseParamsB("gpt-5")).toBeUndefined();
    expect(estimateMemoryGB(7, "Q4_K_M")).toBeGreaterThan(4);
    expect(estimateMemoryGB(7, "Q4_K_M")).toBeLessThan(7);
    expect(estimateMemoryGB(undefined, undefined, 4_000_000_000)).toBeCloseTo(5.1, 0);
  });
  it("guesses capabilities as heuristics", () => {
    expect(guessCapabilities("nomic-embed-text")).toEqual(["embeddings"]);
    expect(guessCapabilities("llava:13b")).toEqual(expect.arrayContaining(["vision"]));
    expect(guessCapabilities("llava:13b")).not.toContain("tools");
  });
  const M = (o: Partial<ModelInfo> & { id: string }): ModelInfo => finalize({ provider: "p", local: false, ...o });
  const models = [
    M({ id: "tiny-3b", local: true, paramsB: 3, capabilities: ["chat", "json"], capabilitySource: "reported" }),
    M({ id: "coder-32b", local: true, paramsB: 32, capabilities: ["chat", "tools", "code", "json"], capabilitySource: "reported" }),
    M({ id: "big-cloud", capabilities: ["chat", "tools", "code", "reasoning", "vision", "json"], capabilitySource: "reported", contextWindow: 200000 }),
    M({ id: "embedder", local: true, paramsB: 0.1, capabilities: ["embeddings"], capabilitySource: "reported" }),
  ];
  it("routes by task", () => {
    const p = { privacy: "any", optimise: "quality" } as const;
    expect(chooseModel("classify", models, p)!.model.id).toBe("tiny-3b");
    expect(chooseModel("embed", models, p)!.model.id).toBe("embedder");
    expect(chooseModel("vision", models, p)!.model.id).toBe("big-cloud");
    expect(chooseModel("architecture", models, p)!.model.id).toBe("big-cloud");
  });
  it("honours local-only privacy, explicit assignments and avoid-lists", () => {
    expect(chooseModel("code", models, { privacy: "local-only", optimise: "quality" })!.model.id).toBe("coder-32b");
    expect(chooseModel("vision", models, { privacy: "local-only", optimise: "quality" })).toBeNull(); // no local vision model: refuses rather than leaking to cloud
    expect(chooseModel("code", models, { privacy: "any", optimise: "quality", assignments: { code: "p::tiny-3b" } })!.model.id).toBe("tiny-3b");
    expect(chooseModel("review", models, { privacy: "any", optimise: "quality", avoid: ["p::big-cloud"] })!.model.id).toBe("coder-32b");
  });
  it("prefers local models when optimising for cost and gives reasons", () => {
    const c = chooseModel("code", models, { privacy: "any", optimise: "cost" })!;
    expect(c.model.local).toBe(true);
    expect(c.reasons.join()).toMatch(/local = free/);
    expect(Object.keys(recommendForAll(models, { privacy: "any", optimise: "quality" }))).toHaveLength(10);
  });
  it("judges memory fit", () => {
    expect(fitsMemory({ ...models[1]!, memoryGB: 20 }, 64)).toBe("fits");
    expect(fitsMemory({ ...models[1]!, memoryGB: 20 }, 24)).toBe("tight");
    expect(fitsMemory({ ...models[1]!, memoryGB: 40 }, 24)).toBe("too-large");
  });
});
