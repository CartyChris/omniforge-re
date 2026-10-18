import type { StructureExtractor, StructureResult } from "@omniforge/core";
import type { Parser } from "web-tree-sitter";
import { extractFile, langOf, languageLabel } from "./languages.js";

const MAX_FILES = 3000, MAX_BYTES = 400_000, BUDGET_MS = 25_000;

/** Tree-sitter backed extractor; `parserFor` supplies parsers (Node/Bun file loader or browser URL loader). Files in other languages are counted, not guessed at. */
export type ParserFor = (language: string) => Promise<Parser>;

export function createStructureExtractor(parserFor: ParserFor): StructureExtractor {
  return {
    async extract(files, o): Promise<StructureResult> {
      const out: StructureResult = { files: [], parsed: 0, unsupported: 0, failed: [], languages: [] };
      const langs = new Set<string>(); let n = 0; const t0 = Date.now();
      for (const f of files) {
        if (o?.signal?.aborted) break;
        if (Date.now() - t0 > BUDGET_MS) { out.failed.push({ path: "(remaining files)", error: `time budget of ${BUDGET_MS / 1000}s reached; the rest were not parsed` }); break; }
        const lang = langOf(f.path);
        if (!lang || f.content.length > MAX_BYTES) { if (!lang && /\.(?:rb|php|kt|kts|swift|scala|c|cc|cpp|h|hpp|dart|ex|exs|lua|pl|r)$/i.test(f.path)) out.unsupported++; continue; }
        if (++n > MAX_FILES) { out.unsupported++; continue; }
        try {
          const parser = await parserFor(lang);
          const tree = parser.parse(f.content);
          if (!tree) throw new Error("the parser returned no tree");
          try { out.files.push(extractFile(tree.rootNode, f.path, lang)); out.parsed++; langs.add(languageLabel(lang)); } finally { tree.delete(); }
        } catch (e) { out.failed.push({ path: f.path, error: (e as Error).message.slice(0, 160) }); if (/grammar files were not found|could not be loaded/i.test((e as Error).message)) throw e; }
      }
      out.languages = [...langs].sort();
      return out;
    },
  };
}
