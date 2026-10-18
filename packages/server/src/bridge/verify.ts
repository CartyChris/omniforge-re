/** Desktop-engine orchestration for "compare my rebuild with the reference": capture both at fixed viewports and build the report. */
import type { VerificationReport } from "@omniforge/core";
import { UserError } from "../http.js";
import { buildReport, type CapturedView } from "../verify.js";
import type { PlaywrightRenderer } from "./render.js";

export const VIEWPORTS = [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }] as const;
const data = (b: Uint8Array) => `data:image/png;base64,${Buffer.from(b).toString("base64")}`;

function httpUrl(label: string, v: unknown): string {
  let u: URL; try { u = new URL(String(v)); } catch { throw new UserError(`${label} is not a valid URL.`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UserError(`${label} must be an http(s) URL.`);
  return u.href;
}

export interface VerifyResult { report: VerificationReport; images: Record<string, { reference: string; rebuilt: string; diff: string }> }

export async function verifyUrls(renderer: PlaywrightRenderer, referenceUrl: unknown, rebuiltUrl: unknown): Promise<VerifyResult> {
  const reference = httpUrl("The reference", referenceUrl), rebuilt = httpUrl("The rebuilt app", rebuiltUrl);
  const shoot = async (url: string): Promise<CapturedView[]> => {
    const out: CapturedView[] = [];
    for (const v of VIEWPORTS) { const c = await renderer.capture(url, { width: v.width, height: v.height, maxHeight: 5000 }); out.push({ ...v, png: new Uint8Array(c.png), html: c.html, finalUrl: c.finalUrl, consoleErrors: c.consoleErrors }); }
    return out;
  };
  const [ref, reb] = [await shoot(reference), await shoot(rebuilt)]; // sequential: one browser, bounded memory
  const { report, diffPngs } = buildReport({ url: reference, views: ref }, { url: rebuilt, views: reb });
  const images: VerifyResult["images"] = {};
  for (const v of ref) images[v.name] = { reference: data(v.png), rebuilt: data(reb.find((x) => x.name === v.name)!.png), diff: data(diffPngs[v.name]!) };
  return { report, images };
}
