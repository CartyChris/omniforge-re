import { createStructureExtractor } from "./extractor.js";
import { browserParserFor } from "./browser-loader.js";
/** Extractor for the browser / Web Worker (grammars fetched from `base`, default /tree-sitter/). */
export const browserStructureExtractor = (base = "/tree-sitter/") => createStructureExtractor(browserParserFor(base));
