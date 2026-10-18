/** web-tree-sitter in the browser (also inside a Web Worker): runtime and grammars are fetched from `base` on first use. */
import type { Language, Parser as ParserT } from "web-tree-sitter";
import { GRAMMAR_FILES, RUNTIME_FILE } from "./grammars.js";

export function browserParserFor(base = "/tree-sitter/") {
  const root = base.endsWith("/") ? base : base + "/";
  let ready: Promise<typeof import("web-tree-sitter")> | undefined;
  const langs = new Map<string, Promise<Language>>(); const parsers = new Map<string, ParserT>();
  const init = () => (ready ??= (async () => {
    const mod = await import("web-tree-sitter");
    await mod.Parser.init({ locateFile: (name: string) => root + (name === "tree-sitter.wasm" ? RUNTIME_FILE : name) });
    return mod;
  })());
  return async (lang: string): Promise<ParserT> => {
    const file = GRAMMAR_FILES[lang]; if (!file) throw new Error(`No grammar for ${lang}`);
    const mod = await init();
    let l = langs.get(lang);
    if (!l) { l = mod.Language.load(root + file).catch((e: Error) => { langs.delete(lang); throw new Error(`The ${lang} grammar could not be loaded from ${root}${file}: ${e.message}`); }); langs.set(lang, l); }
    let p = parsers.get(lang); if (!p) { p = new mod.Parser(); p.setLanguage(await l); parsers.set(lang, p); }
    return p;
  };
}
