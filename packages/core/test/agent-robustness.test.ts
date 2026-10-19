import { describe, expect, it } from "vitest";
import { executeGraph, executeTool, findStub, memoryFS, runAgentTask, task, type RunContext, type ToolContext } from "../src/ai/agents";
import { finalize } from "../src/ai/models";
import type { ChatEvent, ChatRequest, Provider, ToolCall } from "../src/ai/types";

const call = (name: string, args: any): ToolCall => ({ id: Math.random().toString(36).slice(2), name, args });
const model = finalize({ id: "m", provider: "s", local: true, paramsB: 30, maxOutput: 8192, capabilities: ["chat", "tools", "code"], capabilitySource: "reported" });
/** Each task's script is chosen by a keyword in its objective; `step` counts that task's own model turns. */
function scripted(by: Record<string, (step: number, req: ChatRequest) => { calls?: ToolCall[]; text?: string; finish?: string }>, seen: ChatRequest[] = []): Provider {
  return { id: "s", kind: "openai-compat", label: "s", local: true, listModels: async () => [], health: async () => ({ ok: true, latencyMs: 0 }),
    async *chat(req): AsyncGenerator<ChatEvent> {
      seen.push({ ...req, messages: [...req.messages] }); const user = String(req.messages[0]!.content); const key = Object.keys(by).find((k) => user.includes(k))!;
      const r = by[key]!(req.messages.filter((m) => m.role === "assistant").length, req);
      if (r.text) yield { type: "text", text: r.text };
      for (const c of r.calls ?? []) yield { type: "tool_call", call: c };
      yield { type: "done", finish: (r.finish as any) ?? (r.calls?.length ? "tool_calls" : "stop") };
    } };
}
const ctxFor = (p: Provider, files: Record<string, string> = {}): RunContext & { tools: ToolContext & { fs: ReturnType<typeof memoryFS> } } => ({ tools: { fs: memoryFS(files), writes: [], deletes: [] } as any, providerFor: () => p, models: [model], prefs: { privacy: "any", optimise: "quality" } });

describe("parallel tasks cannot erase each other's edits", () => {
  it("a stale overwrite is refused; after re-reading, the write goes through (the core guarantee, two tasks sharing one workspace)", async () => {
    const fs = memoryFS({ "App.tsx": "routes: base" }); const versions = new Map<string, number>();
    const A: ToolContext = { fs, writes: [], deletes: [], versions, seen: new Map() }; const B: ToolContext = { fs, writes: [], deletes: [], versions, seen: new Map() };
    expect(await executeTool("read_file", { path: "App.tsx" }, A)).toBe("routes: base");
    expect(await executeTool("read_file", { path: "App.tsx" }, B)).toBe("routes: base");
    expect(await executeTool("write_file", { path: "App.tsx", content: "routes: base,/search" }, B)).toMatch(/^Wrote/);
    expect(await executeTool("write_file", { path: "App.tsx", content: "routes: base,/auth" }, A)).toMatch(/changed since you last read it/); // would have erased /search
    expect(fs.read("App.tsx")).toBe("routes: base,/search");
    expect(await executeTool("read_file", { path: "App.tsx" }, A)).toBe("routes: base,/search");
    expect(await executeTool("write_file", { path: "App.tsx", content: "routes: base,/search,/auth" }, A)).toMatch(/^Wrote/);
    expect(await executeTool("write_file", { path: "New.tsx", content: "x" }, A)).toMatch(/^Wrote/); // new files need no read
    const C: ToolContext = { fs, writes: [], deletes: [], versions, seen: new Map() };
    expect(await executeTool("write_file", { path: "App.tsx", content: "blind" }, C)).toMatch(/have not read it yet/); // never read → no blind overwrite
    expect(await executeTool("edit_file", { path: "App.tsx", old_string: "/auth", new_string: "/auth,/admin" }, C)).toMatch(/^Edited/); // edits apply to current content
  });
  it("three feature tasks in parallel all edit App.tsx; none is lost; files are attributed to the task that wrote them", async () => {
    const mk = (route: string) => async (_s: number, req: ChatRequest) => {
      await new Promise((r) => setTimeout(r, Math.random() * 8)); // interleave
      const lastA = req.messages.map((m) => m.role).lastIndexOf("assistant"); const results = req.messages.slice(lastA + 1).map((m) => String(m.content));
      const last = results.find((r) => /^routes:/.test(r)) ?? "";
      if (req.messages.length === 1 || results.some((r) => /changed since/.test(r))) return { calls: [call("read_file", { path: "App.tsx" })] };
      if (/^routes:/.test(last)) return { calls: [call("write_file", { path: "App.tsx", content: `${last},${route}` }), call("write_file", { path: `${route.slice(1)}.tsx`, content: "export {}" })] };
      return { calls: [call("finish", { summary: "ok" })] };
    };
    const p: Provider = { id: "s", kind: "openai-compat", label: "s", local: true, listModels: async () => [], health: async () => ({ ok: true, latencyMs: 0 }),
      async *chat(req) { const key = ["feat-a", "feat-b", "feat-c"].find((k) => String(req.messages[0]!.content).includes(k))!; const r = await mk(`/${key.slice(-1)}`)(0, req); for (const c of r.calls ?? []) yield { type: "tool_call", call: c }; yield { type: "done", finish: "tool_calls" }; } };
    const ctx = ctxFor(p, { "App.tsx": "routes: base" });
    const res = await executeGraph(["feat-a", "feat-b", "feat-c"].map((o) => task({ role: "development", objective: o })), ctx, { concurrency: 3 });
    const app = ctx.tools.fs.files["App.tsx"]!; for (const r of ["/a", "/b", "/c"]) expect(app, app).toContain(r);
    for (const t of res) { expect(t.status).toBe("done"); expect(t.files!.filter((f) => f !== "App.tsx")).toEqual([`${t.objective.slice(-1)}.tsx`]); }
  });
  it("edit_file refuses ambiguous, missing and unsafe edits", async () => {
    const c: ToolContext = { fs: memoryFS({ "a.ts": "x x" }), writes: [], deletes: [] };
    expect(await executeTool("edit_file", { path: "a.ts", old_string: "x", new_string: "y" }, c)).toMatch(/occurs 2 times/);
    expect(await executeTool("edit_file", { path: "a.ts", old_string: "z", new_string: "y" }, c)).toMatch(/not found/);
    expect(await executeTool("edit_file", { path: "../a.ts", old_string: "x", new_string: "y" }, c)).toMatch(/unsafe/);
    expect(await executeTool("edit_file", { path: "b.ts", old_string: "x", new_string: "y" }, c)).toMatch(/does not exist/);
    expect(await executeTool("edit_file", { path: "a.ts", old_string: "x x", new_string: ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_") }, c)).toMatch(/secret-like/);
    expect(await executeTool("edit_file", { path: "a.ts", old_string: "x x", new_string: "$& $1" }, c)).toMatch(/Edited/); expect(c.fs.read("a.ts")).toBe("$& $1"); // no regex replacement patterns
  });
});

describe("outputs that look finished but are not", () => {
  it("a reply cut off at the output limit is not executed; the model is told and the limit is raised", async () => {
    const seen: ChatRequest[] = [];
    const p = scripted({ big: (s) => s === 0 ? { calls: [call("write_file", { _raw: '{"path":"big.ts","content":"export const' })], finish: "length" } : s === 1 ? { calls: [call("write_file", { path: "big.ts", content: "export const a = 1;" })] } : { calls: [call("finish", { summary: "ok" })] } }, seen);
    const ctx = ctxFor(p); const r = await runAgentTask(task({ role: "development", objective: "big" }), ctx);
    expect(r.status).toBe("done"); expect(ctx.tools.fs.files["big.ts"]).toBe("export const a = 1;");
    expect(String(seen[1]!.messages.at(-1)!.content)).toMatch(/cut off at the output limit/);
    expect(seen[1]!.maxTokens).toBeGreaterThan(seen[0]!.maxTokens!);
  });
  it("feature tasks must write something; empty files and stubbed code fail their checks", async () => {
    const p = scripted({ prose: () => ({ text: "I implemented the feature." }), empty: (s) => s === 0 ? { calls: [call("write_file", { path: "SPEC.md", content: "   " })] } : { calls: [call("finish", { summary: "ok" })] }, stub: (s) => s === 0 ? { calls: [call("write_file", { path: "f.ts", content: "export function f() {\n  // TODO: implement\n}" })] } : { calls: [call("finish", { summary: "ok" })] } });
    const res = await executeGraph([
      task({ role: "development", objective: "prose", acceptance: ["writes_files", "No placeholder or TODO stubs"] }),
      task({ role: "architecture", objective: "empty", acceptance: ["file_exists:SPEC.md"] }),
      task({ role: "development", objective: "stub", acceptance: ["writes_files", "No placeholder or TODO stubs"] }),
    ], ctxFor(p));
    const by = Object.fromEntries(res.map((t) => [t.objective, t]));
    expect(by.prose!.status).toBe("failed"); expect(by.prose!.output).toMatch(/without writing or changing any file/);
    expect(by.empty!.status).toBe("failed"); expect(by.empty!.output).toMatch(/SPEC.md is empty/);
    expect(by.stub!.status).toBe("failed"); expect(by.stub!.output).toMatch(/no stubs in f\.ts/);
  });
  it("stub detection: real markers only", () => {
    for (const bad of ["// TODO: implement", "# TODO", "/* ... rest of the code */", "// ... existing code", 'throw new Error("Not implemented")', "raise NotImplementedError", "Lorem ipsum dolor", "todo!()".replace("todo", "unimplemented")]) expect(findStub(`a\n${bad}\nb`), bad).toBeTruthy();
    for (const ok of ["const todo = list.filter(t => !t.done);", "// Implemented with a TODO list UI (TODO(alice)) ", "export const placeholderText = props.placeholder;"]) expect(findStub(ok), ok).toBeUndefined();
  });
});
