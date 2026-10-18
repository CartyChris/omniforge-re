import { checkVulnerabilities, uid, type Evidence, type Finding, type Investigation } from "@omniforge/core";
import { useApp } from "./store";
import { smartFetch } from "./net";

const SEV: Record<string, Finding["severity"]> = { critical: "high", high: "high", medium: "medium", low: "low", unknown: "info" };

/** Explicit, user-triggered OSV.dev check. Sends package names + exact versions to api.osv.dev (never in local-only mode). */
export async function runVulnerabilityCheck(inv: Investigation): Promise<Investigation> {
  const { settings, bridge } = useApp.getState();
  if (settings.localOnly) throw new Error("Local-only mode is on: the vulnerability check contacts api.osv.dev, so it is disabled. Turn the mode off in Settings to run it.");
  const r = await checkVulnerabilities(inv.dependencies, { fetch: smartFetch(() => bridge) });
  const evidence: Evidence[] = []; const findings: Finding[] = [];
  for (const v of r.items) {
    const id = uid("ev");
    evidence.push({ id, kind: "observed", method: "osv", source: `https://osv.dev/vulnerability/${v.ids[0]}`, timestamp: new Date().toISOString(), confidence: 1, summary: `${v.package}@${v.version}: ${v.ids.slice(0, 3).join(", ")} (${v.severity})`, related: [] });
    findings.push({ id: uid("fd"), area: "security", severity: SEV[v.severity] ?? "info", title: `Known vulnerability in ${v.package}@${v.version}`, detail: `${v.summary}${v.fixed?.length ? ` Fixed in ${v.fixed.join(", ")}.` : ""} ${v.ids.join(", ")}. Declared in ${v.source}.`, evidence: [id] });
  }
  const keep = inv.findings.filter((f) => !f.title.startsWith("Known vulnerability in "));
  return { ...inv, findings: [...findings, ...keep], evidence: [...inv.evidence.filter((e) => e.method !== "osv"), ...evidence], vulnerabilities: { checkedAt: new Date().toISOString(), checked: r.checked, skipped: r.skipped, items: r.items } };
}
