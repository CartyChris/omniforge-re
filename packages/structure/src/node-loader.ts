/**
 * web-tree-sitter runtime + grammar loading for Node, Vercel functions and the Bun-compiled desktop engine.
 * Grammar files are plain assets found, in order: $OMNIFORGE_GRAMMARS (the desktop app's resource folder), a `tree-sitter/` folder next to this
 * module, then the installed npm packages (development, tests). Missing assets are an explicit error, never a silent skip.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Language, Parser as ParserT } from "web-tree-sitter";
import { GRAMMAR_FILES, RUNTIME_FILE } from "./grammars.js";
import { assembleAssets } from "../assets.mjs";


export function assetDir(): string {
  const tried: string[] = [];
  const ok = (d: string | undefined) => { if (!d) return false; tried.push(d); return fs.existsSync(path.join(d, RUNTIME_FILE)) && fs.existsSync(path.join(d, GRAMMAR_FILES.python!)); };
  const env = process.env.OMNIFORGE_GRAMMARS; if (ok(env)) return env!;
  let here: string | undefined; try { here = path.dirname(fileURLToPath(import.meta.url)); } catch { /* not an ES module context */ }
  if (here) for (const d of [path.join(here, "tree-sitter"), path.join(here, "..", "tree-sitter")]) if (ok(d)) return d;
  // development / tests: assemble from the installed packages
  try { const out = assembleAssets(here ?? process.cwd()); if (ok(out)) return out; } catch { /* fall through to the error below */ }
  throw new Error(`Tree-sitter grammar files were not found (looked in: ${tried.join(", ") || "nowhere"}). Set OMNIFORGE_GRAMMARS to a folder with ${RUNTIME_FILE} and the tree-sitter-*.wasm grammars.`);
}

let ready: Promise<{ Parser: typeof ParserT; Language: typeof Language; dir: string }> | undefined;
const langs = new Map<string, Promise<Language>>();
const parsers = new Map<string, ParserT>();

async function init() {
  return (ready ??= (async () => {
    const dir = assetDir();
    const mod = await import("web-tree-sitter");
    await mod.Parser.init({ locateFile: (name: string) => path.join(dir, name === "tree-sitter.wasm" ? RUNTIME_FILE : name) });
    return { Parser: mod.Parser, Language: mod.Language, dir };
  })());
}

/** A parser configured for `lang` (cached; grammars are loaded on first use). */
export async function nodeParserFor(lang: string): Promise<ParserT> {
  const file = GRAMMAR_FILES[lang]; if (!file) throw new Error(`No grammar for ${lang}`);
  const { Parser, Language, dir } = await init();
  let l = langs.get(lang); if (!l) { l = Language.load(new Uint8Array(fs.readFileSync(path.join(dir, file)))); langs.set(lang, l); }
  let p = parsers.get(lang); if (!p) { p = new Parser(); p.setLanguage(await l); parsers.set(lang, p); }
  return p;
}
