// Plain ESM (no TypeScript) so build tooling (vite.config.ts, scripts) can import it without compiling this package.
import fs from "node:fs";
import path from "node:path";

export const RUNTIME_FILE = "web-tree-sitter.wasm";
export const GRAMMAR_FILES = { python: "tree-sitter-python.wasm", javascript: "tree-sitter-javascript.wasm", typescript: "tree-sitter-typescript.wasm", tsx: "tree-sitter-tsx.wasm", go: "tree-sitter-go.wasm", java: "tree-sitter-java.wasm", rust: "tree-sitter-rust.wasm", "c-sharp": "tree-sitter-c-sharp.wasm" };
export const ASSET_FILES = [RUNTIME_FILE, ...Object.values(GRAMMAR_FILES)];

/** Find an installed package by walking up from `start` (works with pnpm's symlinked node_modules). */
export function findPackage(name, start) {
  for (let d = start; ; d = path.dirname(d)) {
    const c = path.join(d, "node_modules", name);
    if (fs.existsSync(c)) return fs.realpathSync(c);
    if (path.dirname(d) === d) return undefined;
  }
}

/** Assemble runtime + grammars from the installed npm packages into one folder (created next to web-tree-sitter) and return it. */
export function assembleAssets(start) {
  const wts = findPackage("web-tree-sitter", start), vsc = findPackage("@vscode/tree-sitter-wasm", start);
  if (!wts || !vsc) throw new Error("web-tree-sitter and @vscode/tree-sitter-wasm are not installed");
  const out = path.join(wts, ".omniforge-grammars");
  if (!ASSET_FILES.every((f) => fs.existsSync(path.join(out, f)))) {
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(path.join(wts, RUNTIME_FILE), path.join(out, RUNTIME_FILE));
    for (const f of Object.values(GRAMMAR_FILES)) fs.copyFileSync(path.join(vsc, "wasm", f), path.join(out, f));
  }
  return out;
}
