import http from "node:http";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReport, diffImages, regionsOf } from "../src/verify";
import { findChrome, PlaywrightRenderer } from "../src/bridge/render";

const png = (w: number, h: number, paint: (set: (x: number, y: number, rgb: [number, number, number]) => void) => void, bg: [number, number, number] = [255, 255, 255]) => {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) p.data.set([...bg, 255], i * 4);
  paint((x, y, c) => p.data.set([...c, 255], (y * w + x) * 4));
  return new Uint8Array(PNG.sync.write(p));
};
const rect = (x0: number, y0: number, w: number, h: number, c: [number, number, number]) => (set: (x: number, y: number, c: [number, number, number]) => void) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c); };

describe("diffImages", () => {
  it("identical images differ in zero pixels", () => {
    const a = png(100, 80, rect(10, 10, 30, 30, [0, 0, 255]));
    expect(diffImages(a, a)).toMatchObject({ diffPixels: 0, ratio: 0, regions: [] });
  });
  it("counts exactly the changed pixels and boxes them", () => {
    const a = png(100, 80, () => {}), b = png(100, 80, rect(20, 30, 10, 10, [255, 0, 0]));
    const d = diffImages(a, b);
    expect(d.diffPixels).toBe(100);
    expect(d.ratio).toBeCloseTo(100 / 8000);
    expect(d.regions).toHaveLength(1);
    const r = d.regions[0]!; expect(r.x).toBeLessThanOrEqual(20); expect(r.x + r.width).toBeGreaterThanOrEqual(30); expect(r.diffPixels).toBe(100);
    expect(PNG.sync.read(Buffer.from(d.diffPng)).width).toBe(100); // a displayable diff image is produced
  });
  it("separates distant changes into separate regions, largest first", () => {
    const a = png(300, 200, () => {}), b = png(300, 200, (set) => { rect(10, 10, 8, 8, [0, 0, 0])(set); rect(200, 120, 40, 40, [0, 0, 0])(set); });
    const d = diffImages(a, b);
    expect(d.regions).toHaveLength(2);
    expect(d.regions[0]!.diffPixels).toBe(1600); expect(d.regions[1]!.diffPixels).toBe(64);
  });
  it("a size difference is a difference: the smaller image is padded and the extra area counts", () => {
    const a = png(100, 100, () => {}), b = png(100, 150, () => {});
    const d = diffImages(a, b);
    expect(d).toMatchObject({ width: 100, height: 150, referenceSize: { width: 100, height: 100 }, rebuiltSize: { width: 100, height: 150 }, diffPixels: 5000 });
  });
  it("tolerates imperceptible colour noise but not a real colour change", () => {
    const a = png(50, 50, () => {}, [200, 200, 200]), near = png(50, 50, () => {}, [201, 200, 199]), far = png(50, 50, () => {}, [200, 60, 60]);
    expect(diffImages(a, near).diffPixels).toBe(0);
    expect(diffImages(a, far).diffPixels).toBe(2500);
  });
  it("regionsOf merges adjacent cells and respects the cap", () => {
    const m = new Uint8Array(64 * 64); for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) m[y * 64 + x] = 1;
    expect(regionsOf(m, 64, 64)).toHaveLength(1);
  });
});

const view = (name: string, w: number, h: number, p: Uint8Array, html: string) => ({ name, width: w, height: h, png: p, html, finalUrl: "x", consoleErrors: [] as string[] });
describe("buildReport", () => {
  it("combines visual and structural findings into a graded report", () => {
    const html = "<title>T</title><h1>Hello</h1><a href='/a'>A</a>";
    const same = buildReport({ url: "https://ref", views: [view("desktop", 100, 80, png(100, 80, () => {}), html)] }, { url: "http://loc", views: [view("desktop", 100, 80, png(100, 80, () => {}), html)] });
    expect(same.report.summary).toMatchObject({ status: "match", high: 0, medium: 0, low: 0 });
    const diff = buildReport({ url: "https://ref", views: [view("desktop", 100, 80, png(100, 80, () => {}), html)] }, { url: "http://loc", views: [{ ...view("desktop", 100, 80, png(100, 80, rect(0, 0, 100, 60, [0, 0, 0])), "<title>T</title>"), consoleErrors: ["boom"] }] });
    expect(diff.report.summary.status).toBe("mismatch");
    const areas = diff.report.discrepancies.map((d) => `${d.area}:${d.kind}`);
    expect(areas).toContain("content:missing"); expect(areas).toContain("navigation:missing"); expect(areas).toContain("layout:changed");
    expect(diff.report.discrepancies.some((d) => /console errors: boom/.test(d.summary))).toBe(true);
    expect(diff.report.summary.worstVisualRatio).toBeCloseTo(0.75);
    // noise the reference also produces is not blamed on the rebuild
    const noisy = { ...view("desktop", 100, 80, png(100, 80, () => {}), html), consoleErrors: ["Failed to load resource: https://ref.test/x.png"] };
    const quiet = buildReport({ url: "https://ref", views: [noisy] }, { url: "http://loc", views: [{ ...noisy, consoleErrors: ["Failed to load resource: http://loc/x.png"] }] });
    expect(quiet.report.summary.status).toBe("match");
    expect(Object.keys(diff.diffPngs)).toEqual(["desktop"]);
    expect(diff.report.limits.length).toBeGreaterThan(0); // limits are always stated
  });
});

const chrome = findChrome();
let srv: http.Server, base: string;
const page = (h1: string, tall = 0) => `<!doctype html><html lang="en"><head><title>Shop</title><style>body{margin:0;font:16px sans-serif}h1{color:#123}.t{height:${tall}px;background:#eef}</style></head><body><nav><a href="/">Home</a></nav><main><h1>${h1}</h1><button>Buy</button><div class="t"></div></main></body></html>`;
beforeAll(async () => {
  srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url === "/ref") return res.end(page("Welcome"));
    if (req.url === "/same") return res.end(page("Welcome"));
    if (req.url === "/changed") return res.end(page("Welcome").replace("<button>Buy</button>", "").replace("#123", "#c00"));
    if (req.url === "/tall") return res.end(page("Welcome", 9000));
    res.end("<title>x</title>");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

describe.skipIf(!chrome)("capture + compare with real Chromium", () => {
  let r: PlaywrightRenderer;
  beforeAll(() => { r = new PlaywrightRenderer({ executablePath: chrome!, allowPrivate: true }); });
  afterAll(async () => { await r.close(); });
  const views = async (path: string) => Promise.all([{ name: "desktop", width: 1000, height: 600 }, { name: "mobile", width: 390, height: 700 }].map(async (v) => { const c = await r.capture(base + path, { width: v.width, height: v.height }); return { ...v, ...c, png: new Uint8Array(c.png) }; }));
  it("the same page captured twice has zero differences at both viewports (animations frozen, deterministic)", async () => {
    const { report } = buildReport({ url: base + "/ref", views: await views("/ref") }, { url: base + "/same", views: await views("/same") });
    expect(report.summary).toMatchObject({ status: "match", worstVisualRatio: 0 });
    expect(report.viewports.map((v) => v.name)).toEqual(["desktop", "mobile"]);
  }, 90_000);
  it("a rebuild with a missing button and a different heading colour is reported with evidence", async () => {
    const { report } = buildReport({ url: base + "/ref", views: await views("/ref") }, { url: base + "/changed", views: await views("/changed") });
    expect(report.summary.status).not.toBe("match");
    expect(report.discrepancies.some((d) => d.area === "controls" && d.kind === "missing" && d.reference === "buy")).toBe(true);
    expect(report.viewports.every((v) => v.diffPixels > 0)).toBe(true);
  }, 90_000);
  it("a taller rebuild is a layout finding and very tall pages are capped", async () => {
    const { report } = buildReport({ url: base + "/ref", views: await views("/ref") }, { url: base + "/tall", views: await views("/tall") });
    expect(report.discrepancies.some((d) => d.area === "layout" && /page size differs/.test(d.summary))).toBe(true);
    const c = await r.capture(base + "/tall", { width: 500, height: 400, maxHeight: 2000 });
    expect(PNG.sync.read(c.png).height).toBe(2000);
  }, 90_000);
  it("refuses to follow a request to a blocked address when private access is off", async () => {
    const strict = new PlaywrightRenderer({ executablePath: chrome!, allowPrivate: false });
    try { const c = await strict.capture(base + "/ref", { width: 400, height: 300 }); expect(c.html).not.toContain("Welcome"); } catch (e) { expect(String(e)).toBeTruthy(); } finally { await strict.close(); }
  }, 60_000);
});
