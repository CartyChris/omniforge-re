import { createStructureExtractor } from "./extractor.js";
import { assetDir, nodeParserFor } from "./node-loader.js";
export { assetDir };
/** Extractor for Node, Vercel functions and the Bun-compiled desktop engine (grammars read from disk). */
export const nodeStructureExtractor = () => createStructureExtractor(nodeParserFor);
