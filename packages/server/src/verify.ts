/**
 * Reference-vs-rebuild verification (Node only: needs pngjs). Pure-JS pixel diff — pixelmatch + pngjs — so it also runs inside the
 * Bun-compiled desktop engine and in serverless functions. Capturing pages needs a browser and lives in bridge/verify.ts.
 */
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { diffStructure, extractStructure, summarize, visualDiscrepancies, type VerificationReport, type ViewportVisual, type VisualRegion } from "@omniforge/core";

const PAD = [255, 0, 255, 255] as const; // magenta: padding added to the smaller image so a size difference counts as a difference

function padTo(img: PNG, w: number, h: number): PNG {
  if (img.width === w && img.height === h) return img;
  const out = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) out.data.set(PAD, i * 4);
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
}

/** Connected clusters of differing 16px cells → bounding boxes, biggest first. */
export function regionsOf(mask: Uint8Array, w: number, h: number, cell = 16, max = 12): VisualRegion[] {
  const cw = Math.ceil(w / cell), ch = Math.ceil(h / cell); const count = new Uint32Array(cw * ch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) count[Math.floor(y / cell) * cw + Math.floor(x / cell)]!++;
  const seen = new Uint8Array(cw * ch); const out: VisualRegion[] = [];
  for (let s = 0; s < cw * ch; s++) {
    if (!count[s] || seen[s]) continue;
    const stack = [s]; seen[s] = 1; let x0 = cw, y0 = ch, x1 = 0, y1 = 0, px = 0;
    while (stack.length) {
      const c = stack.pop()!; const cx = c % cw, cy = Math.floor(c / cw);
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy); px += count[c]!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue; const n = ny * cw + nx; if (count[n] && !seen[n]) { seen[n] = 1; stack.push(n); } }
    }
    out.push({ x: x0 * cell, y: y0 * cell, width: Math.min(w, (x1 + 1) * cell) - x0 * cell, height: Math.min(h, (y1 + 1) * cell) - y0 * cell, diffPixels: px });
  }
  return out.sort((a, b) => b.diffPixels - a.diffPixels).slice(0, max);
}

export interface ImageDiff { width: number; height: number; referenceSize: { width: number; height: number }; rebuiltSize: { width: number; height: number }; diffPixels: number; comparedPixels: number; ratio: number; regions: VisualRegion[]; diffPng: Uint8Array }

export function diffImages(reference: Uint8Array, rebuilt: Uint8Array, o: { threshold?: number } = {}): ImageDiff {
  const a = PNG.sync.read(Buffer.from(reference)), b = PNG.sync.read(Buffer.from(rebuilt));
  const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
  const pa = padTo(a, w, h), pb = padTo(b, w, h); const diff = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(pa.data, pb.data, diff.data, w, h, { threshold: o.threshold ?? 0.1, includeAA: false });
  // pixelmatch paints differing pixels pure red (255,0,0) in its output; use that as the mask for clustering
  const mask = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) mask[i] = diff.data[i * 4] === 255 && diff.data[i * 4 + 1] === 0 && diff.data[i * 4 + 2] === 0 ? 1 : 0;
  return { width: w, height: h, referenceSize: { width: a.width, height: a.height }, rebuiltSize: { width: b.width, height: b.height }, diffPixels, comparedPixels: w * h, ratio: w * h ? diffPixels / (w * h) : 0, regions: regionsOf(mask, w, h), diffPng: new Uint8Array(PNG.sync.write(diff)) };
}

export interface CapturedView { name: string; width: number; height: number; png: Uint8Array; html: string; finalUrl: string; consoleErrors: string[] }

/** Combine captures of the reference and the rebuild (same viewports) into a report. `diffPngs` are returned for display, not stored in the report. */
export function buildReport(reference: { url: string; views: CapturedView[] }, rebuilt: { url: string; views: CapturedView[] }): { report: VerificationReport; diffPngs: Record<string, Uint8Array> } {
  const visuals: ViewportVisual[] = []; const diffPngs: Record<string, Uint8Array> = {};
  for (const rv of reference.views) {
    const bv = rebuilt.views.find((v) => v.name === rv.name); if (!bv) continue;
    const d = diffImages(rv.png, bv.png);
    visuals.push({ name: rv.name, width: rv.width, height: rv.height, referenceSize: d.referenceSize, rebuiltSize: d.rebuiltSize, diffPixels: d.diffPixels, comparedPixels: d.comparedPixels, ratio: d.ratio, regions: d.regions });
    diffPngs[rv.name] = d.diffPng;
  }
  const primary = reference.views[0], other = rebuilt.views.find((v) => v.name === primary?.name);
  const structural = primary && other ? diffStructure(extractStructure(primary.html), extractStructure(other.html)) : [];
  // only errors the reference does NOT also produce (a site that logs its own noise is not a defect of the rebuild)
  const known = new Set(reference.views.flatMap((v) => v.consoleErrors).map((e) => e.replace(/https?:\/\/[^\s)]+/g, "<url>")));
  const errs = [...new Set(rebuilt.views.flatMap((v) => v.consoleErrors))].filter((e) => !known.has(e.replace(/https?:\/\/[^\s)]+/g, "<url>"))).slice(0, 5);
  const ds = [...structural, ...visualDiscrepancies(visuals)];
  if (errs.length) ds.push({ id: "c1", area: "controls", kind: "extra", severity: "medium", summary: `The rebuild logs console errors: ${errs.map((e) => e.slice(0, 80)).join(" | ")}`, rebuilt: errs[0] });
  return {
    diffPngs,
    report: {
      createdAt: new Date().toISOString(), reference: reference.url, rebuilt: rebuilt.url, viewports: visuals, discrepancies: ds, summary: summarize(visuals, ds),
      limits: ["Compares the first screen-to-bottom render at each viewport after animations are frozen; interactive states (menus, modals, hover, logged-in views) are not compared.", "Dynamic content (ads, timestamps, carousels, personalised text) can differ without being a defect.", "Text in the structural comparison is shown lower-cased."],
    },
  };
}
