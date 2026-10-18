/** Verification report: visual + structural discrepancies between a reference and a rebuild, and the brief an agent uses to repair them. */
import { untrusted } from "../ai/untrusted.js";
import type { Discrepancy, Severity } from "./structure.js";

export interface VisualRegion { x: number; y: number; width: number; height: number; diffPixels: number }
export interface ViewportVisual {
  name: string; width: number; height: number;
  /** Rendered full-page sizes; a different height is itself a finding. */
  referenceSize: { width: number; height: number }; rebuiltSize: { width: number; height: number };
  diffPixels: number; comparedPixels: number; ratio: number; regions: VisualRegion[];
}
export interface VerificationReport {
  createdAt: string; reference: string; rebuilt: string;
  viewports: ViewportVisual[]; discrepancies: Discrepancy[];
  summary: { status: "match" | "minor" | "mismatch"; high: number; medium: number; low: number; worstVisualRatio: number };
  limits: string[];
}

/** Visual ratio thresholds are deliberately blunt: they only decide how loudly a diff is reported, not whether it is correct. */
export function visualDiscrepancies(vs: ViewportVisual[], startId = 1000): Discrepancy[] {
  const out: Discrepancy[] = []; let n = startId;
  for (const v of vs) {
    if (v.referenceSize.height !== v.rebuiltSize.height || v.referenceSize.width !== v.rebuiltSize.width) {
      const dh = v.rebuiltSize.height - v.referenceSize.height;
      out.push({ id: `v${n++}`, area: "layout", kind: "changed", severity: Math.abs(dh) > 200 ? "high" : "medium", summary: `${v.name}: page size differs (${v.referenceSize.width}×${v.referenceSize.height} reference vs ${v.rebuiltSize.width}×${v.rebuiltSize.height} rebuilt)`, reference: `${v.referenceSize.width}×${v.referenceSize.height}`, rebuilt: `${v.rebuiltSize.width}×${v.rebuiltSize.height}` });
    }
    const sev: Severity | null = v.ratio >= 0.2 ? "high" : v.ratio >= 0.05 ? "medium" : v.ratio >= 0.005 ? "low" : null;
    if (sev) out.push({ id: `v${n++}`, area: "layout", kind: "changed", severity: sev, summary: `${v.name}: ${(v.ratio * 100).toFixed(1)}% of pixels differ${v.regions.length ? `; largest differing areas: ${v.regions.slice(0, 3).map((r) => `${r.width}×${r.height} at (${r.x},${r.y})`).join(", ")}` : ""}` });
  }
  return out;
}

export function summarize(vs: ViewportVisual[], ds: Discrepancy[]): VerificationReport["summary"] {
  const c = (s: Severity) => ds.filter((d) => d.severity === s).length;
  const high = c("high"), medium = c("medium"), low = c("low");
  return { status: high ? "mismatch" : medium || low ? "minor" : "match", high, medium, low, worstVisualRatio: Math.max(0, ...vs.map((v) => v.ratio)) };
}

/**
 * The brief handed to a repair agent. Discrepancy text comes from the REFERENCE site, so it is fenced as untrusted data;
 * the agent is told to fix only the listed differences and the acceptance check is re-running the comparison.
 */
export function repairBrief(r: VerificationReport, max = 40): string {
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  const items = [...r.discrepancies].sort((a, b) => order[a.severity] - order[b.severity]).filter((d) => d.severity !== "low").slice(0, max);
  const body = items.map((d) => `- [${d.severity}] (${d.area}) ${d.summary}${d.reference && d.kind !== "missing" ? `\n    reference: ${d.reference}` : ""}${d.rebuilt && d.kind !== "extra" ? `\n    rebuilt: ${d.rebuilt}` : ""}`).join("\n");
  return `Fix the confirmed differences between the rebuilt app (${r.rebuilt}) and the reference (${r.reference}). Change only what is needed for the items below; do not touch unrelated code.\n\n${untrusted("verification-discrepancies", body || "(none above low severity)", 20_000)}`;
}
