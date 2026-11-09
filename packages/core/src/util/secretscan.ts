/**
 * Loads the Rust secret-scan engine (native/secretscan, compiled to WebAssembly) and adapts it to `SecretScanEngine`.
 * Instantiation is synchronous, so call it only where that is allowed (Node, Bun, web workers — not a browser main thread,
 * where Chrome refuses synchronous compiles of modules over 4 KB). The engine finds candidates; `gitleaks.ts` applies policy.
 */
import { gitleaksRules, type Candidate, type SecretScanEngine } from "./gitleaks";

interface Exports { memory: WebAssembly.Memory; alloc(n: number): number; dealloc(p: number, n: number): void; init(p: number, n: number): number; scan(p: number, n: number): number; out_ptr(): number }

const enc = new TextEncoder();

/** Map ascending UTF-8 byte offsets of `text` to UTF-16 indices in one pass. */
export function utf8ToUtf16(text: string, offsets: number[]): Map<number, number> {
  const want = [...new Set(offsets)].sort((a, b) => a - b); const out = new Map<number, number>();
  let byte = 0, k = 0;
  for (let i = 0; i <= text.length && k < want.length; ) {
    while (k < want.length && want[k] === byte) out.set(want[k++]!, i);
    if (i === text.length) break;
    const c = text.codePointAt(i)!;
    byte += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; i += c > 0xffff ? 2 : 1;
  }
  return out;
}

export function createWasmSecretScan(wasm: Uint8Array | ArrayBuffer): SecretScanEngine {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm as BufferSource), {});
  const x = inst.exports as unknown as Exports;
  const write = (bytes: Uint8Array) => { const p = x.alloc(bytes.length); new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes); return p; };
  // rule table in the same order as gitleaksRules().rules, so indices line up
  const rules = gitleaksRules().rules;
  const parts: number[] = []; const strs: Uint8Array[] = [];
  const u32 = (v: number) => parts.push(v);
  const str = (s: string) => { const b = enc.encode(s); u32(b.length); strs.push(b); parts.push(-strs.length); };
  u32(rules.length);
  for (const r of rules) { u32(r.group ?? 0); str(r.re.source); u32(r.keywords.length); for (const k of r.keywords) str(k); }
  const size = parts.reduce((n, p) => n + (p < 0 ? strs[-p - 1]!.length : 4), 0);
  const buf = new Uint8Array(size); const dv = new DataView(buf.buffer); let at = 0;
  for (const p of parts) { if (p < 0) { buf.set(strs[-p - 1]!, at); at += strs[-p - 1]!.length; } else { dv.setUint32(at, p, true); at += 4; } }
  const ptr = write(buf); const nFailed = x.init(ptr, buf.length); x.dealloc(ptr, buf.length);
  if (nFailed < 0) throw new Error("secret-scan engine rejected the rule table");
  const failed = new Set(Array.from(new Uint32Array(x.memory.buffer, x.out_ptr(), nFailed)));
  return {
    name: "rust-wasm", failed,
    candidates(text: string): Candidate[] | null {
      const bytes = enc.encode(text);
      const p = write(bytes);
      try {
        const n = x.scan(p, bytes.length); if (n < 0) return null;
        const raw = Array.from(new Uint32Array(x.memory.buffer, x.out_ptr(), n * 5));
        const ascii = bytes.length === text.length;
        const map = ascii ? null : utf8ToUtf16(text, raw.filter((_, i) => i % 5 !== 0));
        const at = (b: number) => (map ? map.get(b)! : b);
        const out: Candidate[] = [];
        for (let i = 0; i < raw.length; i += 5) out.push({ rule: raw[i]!, start: at(raw[i + 1]!), end: at(raw[i + 2]!), sStart: at(raw[i + 3]!), sEnd: at(raw[i + 4]!) });
        return out;
      } finally { x.dealloc(p, bytes.length); }
    },
  };
}
export { setSecretScanEngine, secretScanEngineName } from "./gitleaks";
