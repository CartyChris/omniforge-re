/** Minimal, dependency-free sitemap / sitemap-index parser. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const urls: string[] = [];
  const sitemaps: string[] = [];
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const loc = m[1]!.replace(/&amp;/g, "&");
    (isIndex ? sitemaps : urls).push(loc);
  }
  return { urls, sitemaps };
}
