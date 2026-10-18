/**
 * Structural comparison of a reference page and a rebuilt page (both as rendered HTML). Elements are matched by what a user perceives —
 * role/kind + visible text — never by DOM path, so a rebuild with different markup but the same content and controls is not penalised.
 */
import * as cheerio from "cheerio";

export interface PageStructure {
  title: string; lang: string; description: string;
  headings: { level: number; text: string }[];
  links: { text: string; path: string }[];
  buttons: string[];
  fields: { kind: string; label: string }[];
  images: { alt: string; hasAlt: boolean }[];
  landmarks: string[];
  words: number;
}
export type Severity = "high" | "medium" | "low";
export interface Discrepancy {
  id: string; area: "content" | "navigation" | "controls" | "forms" | "images" | "metadata" | "layout" | "accessibility";
  kind: "missing" | "extra" | "changed"; severity: Severity;
  summary: string; reference?: string; rebuilt?: string;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const pathOf = (href: string) => { try { const u = new URL(href, "http://x"); return u.pathname.replace(/\/+$/, "") || "/"; } catch { return href; } };

export function extractStructure(html: string): PageStructure {
  const $ = cheerio.load(html);
  $("script,style,noscript,template").remove();
  const text = (el: Parameters<typeof $>[0]) => norm($(el).text());
  const labelFor = (el: Parameters<typeof $>[0]) => {
    const e = $(el); const id = e.attr("id");
    return norm(e.attr("aria-label") ?? (id ? $(`label[for="${id}"]`).first().text() : "") ?? "") || norm(e.closest("label").text()) || norm(e.attr("placeholder") ?? "") || norm(e.attr("name") ?? "");
  };
  const landmarks = new Set<string>();
  $("header,nav,main,footer,aside,[role=banner],[role=navigation],[role=main],[role=contentinfo],[role=complementary],[role=search]").each((_, el) => {
    const tag = el.type === "tag" ? el.name : ""; const role = $(el).attr("role");
    landmarks.add(role ?? ({ header: "banner", footer: "contentinfo", nav: "navigation", main: "main", aside: "complementary" } as Record<string, string>)[tag] ?? tag);
  });
  return {
    title: norm($("title").first().text()), lang: ($("html").attr("lang") ?? "").toLowerCase(), description: norm($('meta[name="description"]').attr("content") ?? ""),
    headings: $("h1,h2,h3,h4,h5,h6").map((_, el) => ({ level: Number((el as { name: string }).name.slice(1)), text: text(el) })).get().filter((h) => h.text),
    links: $("a[href]").map((_, el) => ({ text: text(el) || norm($(el).attr("aria-label") ?? ""), path: pathOf($(el).attr("href")!) })).get().filter((l) => (l.text || l.path) && !l.path.startsWith("javascript:")),
    buttons: $("button,[role=button],input[type=submit],input[type=button]").map((_, el) => text(el) || norm($(el).attr("value") ?? $(el).attr("aria-label") ?? "")).get().filter(Boolean),
    fields: $("input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select").map((_, el) => ({ kind: (el as { name: string }).name === "input" ? ($(el).attr("type") ?? "text").toLowerCase() : (el as { name: string }).name, label: labelFor(el) })).get(),
    images: $("img,[role=img]").map((_, el) => { const alt = $(el).attr("alt") ?? $(el).attr("aria-label"); return { alt: norm(alt ?? ""), hasAlt: alt !== undefined }; }).get(),
    landmarks: [...landmarks].sort(),
    words: text("body").split(" ").filter(Boolean).length,
  };
}

const multiset = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return m; };
function setDiff(ref: string[], reb: string[]) {
  const a = multiset(ref), b = multiset(reb); const missing: string[] = [], extra: string[] = [];
  for (const [k, n] of a) for (let i = 0; i < n - (b.get(k) ?? 0); i++) missing.push(k);
  for (const [k, n] of b) for (let i = 0; i < n - (a.get(k) ?? 0); i++) extra.push(k);
  return { missing, extra };
}

/** Compare two structures. Missing items are what a user would notice first (high/medium); extras are low. */
export function diffStructure(ref: PageStructure, reb: PageStructure): Discrepancy[] {
  const out: Discrepancy[] = []; let n = 0;
  const add = (d: Omit<Discrepancy, "id">) => out.push({ id: `d${++n}`, ...d });
  const list = (area: Discrepancy["area"], what: string, a: string[], b: string[], sev: Severity) => {
    const { missing, extra } = setDiff(a, b);
    for (const m of missing.slice(0, 25)) add({ area, kind: "missing", severity: sev, summary: `${what} “${clip(m, 70)}” is on the reference but not in the rebuild`, reference: m });
    for (const e of extra.slice(0, 10)) add({ area, kind: "extra", severity: "low", summary: `${what} “${clip(e, 70)}” is in the rebuild but not on the reference`, rebuilt: e });
  };
  if (ref.title !== reb.title) add({ area: "metadata", kind: "changed", severity: "medium", summary: "Page title differs", reference: ref.title, rebuilt: reb.title });
  if (ref.lang !== reb.lang && ref.lang) add({ area: "metadata", kind: "changed", severity: "low", summary: "Document language differs", reference: ref.lang, rebuilt: reb.lang });
  if (ref.description !== reb.description && ref.description) add({ area: "metadata", kind: "changed", severity: "low", summary: "Meta description differs", reference: clip(ref.description), rebuilt: clip(reb.description) });
  list("content", "Heading", ref.headings.map((h) => `h${h.level} ${h.text}`), reb.headings.map((h) => `h${h.level} ${h.text}`), "high");
  list("navigation", "Link", ref.links.map((l) => `${l.text} → ${l.path}`), reb.links.map((l) => `${l.text} → ${l.path}`), "medium");
  list("controls", "Button", ref.buttons, reb.buttons, "medium");
  list("forms", "Form field", ref.fields.map((f) => `${f.kind}: ${f.label}`), reb.fields.map((f) => `${f.kind}: ${f.label}`), "high");
  list("images", "Image", ref.images.map((i) => i.alt || "(no alt)"), reb.images.map((i) => i.alt || "(no alt)"), "low");
  list("layout", "Landmark", ref.landmarks, reb.landmarks, "low");
  const refNoAlt = ref.images.filter((i) => !i.hasAlt).length, rebNoAlt = reb.images.filter((i) => !i.hasAlt).length;
  if (rebNoAlt > refNoAlt) add({ area: "accessibility", kind: "changed", severity: "medium", summary: `${rebNoAlt - refNoAlt} more image(s) lack alt text than on the reference`, reference: String(refNoAlt), rebuilt: String(rebNoAlt) });
  if (ref.words >= 50 && reb.words < ref.words * 0.6) add({ area: "content", kind: "changed", severity: "high", summary: `The rebuild has far less text (${reb.words} words vs ${ref.words})`, reference: String(ref.words), rebuilt: String(reb.words) });
  return out;
}
