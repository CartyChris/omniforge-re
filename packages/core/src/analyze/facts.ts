import type { Asset, Endpoint, Page, SourceFile, Technology } from "../schema.js";
import type { ExtractedPage } from "./html.js";
import type { JsAnalysis } from "./js.js";

/** Everything the interpretive layers (features, findings, coverage, graph) read. */
export interface Facts {
  pages: Page[];
  extracted: Map<string, ExtractedPage>; // by page url
  responseHeaders: Map<string, Record<string, string>>; // by url (pages + assets)
  cookies: { name: string; secure: boolean; httpOnly: boolean; sameSite?: string; url: string }[];
  assets: Asset[];
  assetBytes: Map<string, number>;
  technologies: Technology[];
  endpoints: Endpoint[];
  js: Map<string, JsAnalysis>; // by script url (or `${pageUrl}#inline-N`)
  css: Map<string, string>; // by url (content, capped)
  files: SourceFile[];
  sourceMaps: { url: string; ok: boolean; recovered: number; total: number; withoutContent: number }[];
  manifests: { url: string; name?: string; display?: string; startUrl?: string; icons: number }[];
  serviceWorkers: string[];
  secretLikeInAssets: { url: string; kinds: string[] }[];
  robots: { host: string; found: boolean; disallowed: number; sitemaps: string[] }[];
  sitemapUrls: number;
  blockedByRobots: string[];
  failedFetches: { url: string; reason: string }[];
  rendered: boolean;
  deobfuscation?: { attempted: number; ok: number; unpacked: number; failed: number; skipped: number; candidates: number; tool?: string };
  limits: { maxPagesHit: boolean; maxDepthHit: boolean; assetsOverLimit: number; queueRemaining: number };
}
