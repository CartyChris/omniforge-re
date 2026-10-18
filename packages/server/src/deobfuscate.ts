/**
 * JavaScript deobfuscation engine for the local worker / desktop app: webcrack (MIT; unminify, obfuscator.io string-array and control-flow
 * decoding, webpack/browserify unpacking) with its decoder code evaluated in a QuickJS-WASM sandbox instead of the default native `isolated-vm`
 * (which cannot load under Bun and has no darwin-x64 build). The sandbox has a memory limit and a hard deadline and no host access
 * (no `process`, `require`, `fetch`). The single-file QuickJS variant is used because it also works inside a `bun build --compile` binary.
 * Loaded lazily: nothing here is imported until a deobfuscation is actually requested.
 */
import type { Deobfuscator, DeobfuscateOutput } from "@omniforge/core";

interface Engine { webcrack: typeof import("webcrack").webcrack; sandbox: (code: string) => Promise<unknown> }
export interface DeobfuscatorOptions { timeoutMs?: number; memoryMB?: number; maxBytes?: number }

let qjs: Promise<import("quickjs-emscripten-core").QuickJSWASMModule> | undefined;
const loadQuickJs = () => (qjs ??= (async () => {
  const [core, variant] = await Promise.all([import("quickjs-emscripten-core"), import("@jitl/quickjs-singlefile-mjs-release-sync")]);
  return core.newQuickJSWASMModuleFromVariant(variant.default);
})());

/** Evaluate `code` in a fresh QuickJS runtime and return its (JSON-able) result. Exported for the containment tests. */
export function quickJsSandbox(o: { timeoutMs: number; memoryMB: number }) {
  return async (code: string): Promise<unknown> => {
    const QuickJS = await loadQuickJs();
    const rt = QuickJS.newRuntime();
    rt.setMemoryLimit(o.memoryMB * 1024 * 1024);
    const deadline = Date.now() + o.timeoutMs;
    rt.setInterruptHandler(() => Date.now() > deadline);
    const ctx = rt.newContext();
    try {
      const res = ctx.evalCode(code, "obfuscated.js");
      if (res.error) { const e = ctx.dump(res.error); res.error.dispose(); throw new Error(`sandbox: ${typeof e === "object" ? JSON.stringify(e) : String(e)}`); }
      const v = ctx.dump(res.value); res.value.dispose();
      return v;
    } finally { ctx.dispose(); rt.dispose(); }
  };
}

export function createDeobfuscator(o: DeobfuscatorOptions = {}): Deobfuscator {
  const opts = { timeoutMs: o.timeoutMs ?? 10_000, memoryMB: o.memoryMB ?? 64, maxBytes: o.maxBytes ?? 3_000_000 };
  let engine: Promise<Engine> | undefined;
  const load = () => (engine ??= import("webcrack").then((m) => ({ webcrack: m.webcrack, sandbox: quickJsSandbox(opts) })));
  return {
    async deobfuscate(code, run): Promise<DeobfuscateOutput> {
      const t0 = Date.now(); const tool = "webcrack";
      if (code.length > opts.maxBytes) return { ok: false, tool, unpacked: false, changed: false, notes: [], error: `script is ${Math.round(code.length / 1000)} kB; the limit is ${Math.round(opts.maxBytes / 1000)} kB` };
      if (run?.signal?.aborted) return { ok: false, tool, unpacked: false, changed: false, notes: [], error: "cancelled" };
      try {
        const e = await load();
        const r = await e.webcrack(code, { sandbox: e.sandbox, mangle: false });
        const notes: string[] = [];
        const bundle = r.bundle;
        const looksBundled = /__webpack_require__|webpackChunk|webpackJsonp|parcelRequire/.test(code) || /\(\s*function\s*\(\s*[a-z]\s*,\s*[a-z]\s*,\s*[a-z]\s*\)\s*\{\s*function/.test(code);
        if (!bundle && looksBundled) notes.push("Looks like a module bundle, but its layout was not recognised, so it was not split into modules (newer webpack layouts are not all supported).");
        const modules = bundle ? [...bundle.modules.values()].map((m) => ({ path: m.path || `${m.id}.js`, code: m.code })) : undefined;
        return { ok: true, tool, code: r.code, modules: modules?.length ? modules : undefined, unpacked: !!modules?.length, changed: r.code.trim() !== code.trim(), notes, ms: Date.now() - t0 };
      } catch (err) {
        return { ok: false, tool, unpacked: false, changed: false, notes: [], error: (err as Error).message.slice(0, 300), ms: Date.now() - t0 };
      }
    },
  };
}
