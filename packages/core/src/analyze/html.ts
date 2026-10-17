import { load } from "cheerio/slim";
import type { FormInfo } from "../schema.js";

export interface ExtractedPage {
  title: string;
  links: string[];
  scripts: string[];
  inlineScripts: string[];
  styles: string[];
  inlineStyles: string[];
  images: string[];
  fonts: string[];
  media: string[];
  manifest?: string;
  iframes: string[];
  forms: FormInfo[];
  headings: { level: number; text: string }[];
  landmarks: string[];
  meta: Record<string, string>;
  navLinks: { text: string; href: string }[];
  interactive: { buttons: number; inputs: number; dialogs: number; links: number };
  a11y: { imagesWithoutAlt: number; inputsWithoutLabel: number; hasLang: boolean; hasMain: boolean };
  signals: {
    tables: number; canvas: number; svg: number; video: number; fileInputs: number; searchInputs: number;
    draggable: number; passwordInputs: number; hreflangs: string[]; colorSchemeMeta: boolean; commandHint: boolean;
    tabs: number; accordions: number; carousels: number; toasts: number; breadcrumbs: boolean; pagination: boolean;
  };
  blockingScripts: number;
  crossOriginScriptsWithoutSri: string[];
  insecureSubresources: string[];
  dataAttributes: string[];
  ids: string[];
  classNames: string[];
  text: string;
  html: string;
}

function abs(href: string | undefined, base: string): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(javascript|mailto|tel|data|blob|about):/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Parse an HTML document into structural facts. All URLs are absolutised. */
export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const $ = load(html);
  const baseHref = $("base[href]").attr("href");
  const base = abs(baseHref, pageUrl) ?? pageUrl;
  const set = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];

  const links = set($("a[href], area[href]").map((_, el) => abs($(el).attr("href"), base)).get());
  const scripts = set($("script[src]").map((_, el) => abs($(el).attr("src"), base)).get());
  const modulePreloads = set(
    $('link[rel="modulepreload"], link[rel="preload"][as="script"]').map((_, el) => abs($(el).attr("href"), base)).get(),
  );
  const inlineScripts = $("script:not([src])")
    .map((_, el) => $(el).html() ?? "")
    .get()
    .filter((s) => s.trim().length > 0);
  const styles = set($('link[rel~="stylesheet"], link[rel="preload"][as="style"]').map((_, el) => abs($(el).attr("href"), base)).get());
  const inlineStyles = $("style").map((_, el) => $(el).html() ?? "").get();
  const srcsetUrls: (string | null)[] = [];
  $("img[srcset], source[srcset]").each((_, el) => {
    for (const part of ($(el).attr("srcset") ?? "").split(",")) srcsetUrls.push(abs(part.trim().split(/\s+/)[0], base));
  });
  const images = set([
    ...$("img[src]").map((_, el) => abs($(el).attr("src"), base)).get(),
    ...srcsetUrls,
    ...$('link[rel~="icon"], link[rel="apple-touch-icon"], meta[property="og:image"]')
      .map((_, el) => abs($(el).attr("href") ?? $(el).attr("content"), base))
      .get(),
  ]);
  const fonts = set($('link[rel="preload"][as="font"]').map((_, el) => abs($(el).attr("href"), base)).get());
  const media = set($("video[src], audio[src], video source[src], audio source[src]").map((_, el) => abs($(el).attr("src"), base)).get());
  const manifest = abs($('link[rel="manifest"]').attr("href"), base) ?? undefined;
  const iframes = set($("iframe[src]").map((_, el) => abs($(el).attr("src"), base)).get());

  const forms: FormInfo[] = $("form")
    .map((_, form) => {
      const $f = $(form);
      const fields = $f
        .find("input, select, textarea")
        .map((__, inp) => {
          const $i = $(inp);
          const id = $i.attr("id");
          const label = (id ? $(`label[for="${id}"]`).text() : "") || $i.attr("aria-label") || $i.attr("placeholder") || "";
          return {
            name: $i.attr("name") ?? id ?? "",
            type: (inp as unknown as { tagName: string }).tagName === "input" ? ($i.attr("type") ?? "text") : (inp as unknown as { tagName: string }).tagName,
            required: $i.is("[required]"),
            label: label.trim().slice(0, 120) || undefined,
          };
        })
        .get();
      return { action: abs($f.attr("action"), base) ?? pageUrl, method: ($f.attr("method") ?? "get").toLowerCase(), fields };
    })
    .get();

  const headings = $("h1, h2, h3, h4")
    .map((_, el) => ({ level: Number((el as unknown as { tagName: string }).tagName.slice(1)), text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 160) }))
    .get()
    .filter((h) => h.text)
    .slice(0, 80);

  const landmarks = set(
    $("header, nav, main, aside, footer, [role]")
      .map((_, el) => $(el).attr("role") ?? (el as unknown as { tagName: string }).tagName)
      .get(),
  );

  const meta: Record<string, string> = {};
  $("meta[name], meta[property], meta[http-equiv]").each((_, el) => {
    const k = $(el).attr("name") ?? $(el).attr("property") ?? $(el).attr("http-equiv");
    const v = $(el).attr("content");
    if (k && v && Object.keys(meta).length < 60) meta[k.toLowerCase()] = v.slice(0, 300);
  });
  const generator = $('meta[name="generator"]').attr("content");
  if (generator) meta.generator = generator;

  const navLinks = $("nav a[href], header a[href], [role=navigation] a[href]")
    .map((_, el) => ({ text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 80), href: abs($(el).attr("href"), base) ?? "" }))
    .get()
    .filter((l) => l.href)
    .slice(0, 100);

  let inputsWithoutLabel = 0;
  $("input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea").each((_, el) => {
    const $i = $(el);
    const id = $i.attr("id");
    const labelled =
      $i.attr("aria-label") || $i.attr("aria-labelledby") || $i.attr("title") || (id && $(`label[for="${id}"]`).length) || $i.closest("label").length;
    if (!labelled) inputsWithoutLabel++;
  });

  const dataAttributes = new Set<string>();
  const ids = new Set<string>();
  const classNames = new Set<string>();
  $("*").each((_, el) => {
    const attribs = (el as unknown as { attribs?: Record<string, string> }).attribs ?? {};
    for (const k of Object.keys(attribs)) if (k.startsWith("data-") && dataAttributes.size < 200) dataAttributes.add(k);
    if (attribs.id && ids.size < 300) ids.add(attribs.id);
    if (attribs.class && classNames.size < 1500) for (const c of attribs.class.split(/\s+/)) if (c) classNames.add(c);
  });

  const searchInputs = $('input[type=search], input[role=searchbox], [role=search] input, input[name*=search i], input[name=q], input[placeholder*=search i], input[aria-label*=search i]').length;
  const signals = {
    tables: $("table").length,
    canvas: $("canvas").length,
    svg: $("svg").length,
    video: $("video").length,
    fileInputs: $("input[type=file]").length,
    searchInputs,
    draggable: $('[draggable="true"]').length,
    passwordInputs: $("input[type=password]").length,
    hreflangs: set($("link[rel=alternate][hreflang]").map((_, el) => $(el).attr("hreflang") ?? null).get()),
    colorSchemeMeta: $('meta[name="color-scheme"], meta[name="theme-color"][media*="prefers-color-scheme"]').length > 0,
    commandHint: /(?:⌘|Ctrl\+?)\s?K\b/.test($("body").text()) || $('[role=combobox][aria-haspopup=listbox], [cmdk-root]').length > 0,
    tabs: $('[role=tablist]').length,
    accordions: $('details, [data-orientation][data-radix-collection-item], [aria-expanded][aria-controls]').length,
    carousels: $('[class*=carousel], [class*=swiper], [class*=slick-]').length,
    toasts: $('[role=alert], [role=status], [class*=toast]').length,
    breadcrumbs: $('[aria-label*=breadcrumb i], nav.breadcrumb, ol.breadcrumb').length > 0,
    pagination: $('[aria-label*=pagination i], nav.pagination, ul.pagination').length > 0,
  };

  const blockingScripts = $("head script[src]").filter((_, el) => !$(el).is("[async],[defer],[type=module]")).length;
  const pageOrigin = (() => { try { return new URL(pageUrl).origin; } catch { return ""; } })();
  const crossOriginScriptsWithoutSri = set(
    $("script[src], link[rel=stylesheet][href]").map((_, el) => {
      const u = abs($(el).attr("src") ?? $(el).attr("href"), base);
      if (!u) return null;
      try { return new URL(u).origin !== pageOrigin && !$(el).attr("integrity") ? u : null; } catch { return null; }
    }).get(),
  );
  const insecureSubresources = pageUrl.startsWith("https:")
    ? set([...scripts, ...styles, ...images, ...media, ...iframes].filter((u) => u.startsWith("http://")))
    : [];
  const canonical = abs($('link[rel="canonical"]').attr("href"), base);
  if (canonical) meta["link:canonical"] = canonical;

  $("script, style, noscript, template").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 4000);

  return {
    title: $("title").first().text().trim().slice(0, 300),
    links,
    scripts: set([...scripts, ...modulePreloads]),
    inlineScripts,
    styles,
    inlineStyles,
    images,
    fonts,
    media,
    manifest,
    iframes,
    forms,
    headings,
    landmarks,
    meta,
    navLinks,
    interactive: {
      buttons: $('button, [role="button"], input[type=submit], input[type=button]').length,
      inputs: $("input, select, textarea").length,
      dialogs: $('dialog, [role="dialog"], [aria-modal="true"]').length,
      links: links.length,
    },
    a11y: {
      imagesWithoutAlt: $("img:not([alt])").length,
      inputsWithoutLabel,
      hasLang: !!$("html").attr("lang"),
      hasMain: $('main, [role="main"]').length > 0,
    },
    signals,
    blockingScripts,
    crossOriginScriptsWithoutSri,
    insecureSubresources,
    dataAttributes: [...dataAttributes],
    ids: [...ids],
    classNames: [...classNames],
    text,
    html,
  };
}

/** Pull url(...) references (fonts, images) out of CSS. */
export function extractCssUrls(css: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    const u = abs(m[2], base);
    if (u) out.add(u);
  }
  for (const m of css.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/gi)) {
    const u = abs(m[1], base);
    if (u) out.add(u);
  }
  return [...out];
}

/** Design tokens visible in CSS: custom properties, colours, font families. */
export function extractDesignTokens(css: string) {
  const vars: Record<string, string> = {};
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)/g)) {
    if (Object.keys(vars).length >= 300) break;
    vars[m[1]!] ??= m[2]!.trim().slice(0, 120);
  }
  const colors = new Map<string, number>();
  for (const m of css.matchAll(/#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b|rgba?\([^)]{5,40}\)|hsla?\([^)]{5,40}\)|oklch\([^)]{5,40}\)/gi)) {
    const c = m[0].toLowerCase();
    colors.set(c, (colors.get(c) ?? 0) + 1);
  }
  const fonts = new Map<string, number>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    const f = m[1]!.split(",")[0]!.replace(/["']/g, "").trim();
    if (f && !f.startsWith("var(")) fonts.set(f, (fonts.get(f) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, count]) => ({ value: k, count }));
  return { variables: vars, colors: top(colors, 24), fonts: top(fonts, 8) };
}
