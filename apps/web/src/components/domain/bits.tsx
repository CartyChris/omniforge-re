import type { Evidence, EvidenceKind, Investigation } from "@omniforge/core";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export function CoverageRing({ value, size = 44, label }: { value: number; size?: number; label?: string }) {
  const r = (size - 6) / 2; const c = 2 * Math.PI * r; const tone = value >= 0.75 ? "var(--ok)" : value >= 0.5 ? "var(--warn)" : "var(--bad)";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${label ?? "Coverage"} ${Math.round(value * 100)}%`} title={label ?? "Investigation coverage: completed checks ÷ applicable checks"}>
      <svg width={size} height={size} className="-rotate-90"><circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth="3.5" /><circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth="3.5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - value)} className="transition-[stroke-dashoffset] duration-500" /></svg>
      <span className="absolute inset-0 grid place-items-center text-[11px] font-semibold tabular-nums">{Math.round(value * 100)}</span>
    </div>
  );
}

const KIND_TONE: Record<EvidenceKind, "ok" | "accent" | "info" | "warn" | "neutral" | "teal"> = { observed: "info", recovered: "ok", dynamic: "teal", reconstructed: "accent", inferred: "warn", unavailable: "neutral" };
const KIND_HELP: Record<EvidenceKind, string> = { observed: "Directly observed (fetched or seen)", recovered: "Exact original code/asset retrieved", dynamic: "Observed while the page ran", reconstructed: "Readable form rebuilt from a bundle or binary — not the original", inferred: "Concluded from other evidence", unavailable: "Examined but not obtainable" };
export const KindBadge = ({ kind }: { kind: EvidenceKind }) => <Badge tone={KIND_TONE[kind]} title={KIND_HELP[kind]}>{kind}</Badge>;
export const kindHelp = KIND_HELP;

export function ConfidenceBar({ value }: { value: number }) {
  return <div className="flex items-center gap-2" title={`${Math.round(value * 100)}% — combined from the independent signals that matched`}><div className="h-1 w-14 overflow-hidden rounded-full bg-overlay"><div className={cn("h-full rounded-full", value >= 0.8 ? "bg-ok" : value >= 0.5 ? "bg-warn" : "bg-bad")} style={{ width: `${value * 100}%` }} /></div><span className="w-8 text-right text-[11px] tabular-nums text-muted">{Math.round(value * 100)}%</span></div>;
}

export function StatusBadge({ s }: { s: Investigation["status"] }) {
  const m = { running: ["info", "Running"], done: ["ok", "Complete"], error: ["bad", "Failed"], cancelled: ["neutral", "Cancelled"], interrupted: ["warn", "Interrupted"], queued: ["neutral", "Queued"] } as const;
  const [tone, label] = m[s] ?? m.done;
  return <Badge tone={tone} dot>{label}</Badge>;
}

export function TechChips({ inv, max = 6 }: { inv: Investigation; max?: number }) {
  const t = inv.technologies.filter((x) => x.confidence >= 0.6 && !["Language", "Build system"].includes(x.category)).slice(0, max);
  if (!t.length) return <span className="text-xs text-faint">No technologies detected</span>;
  return <div className="flex flex-wrap gap-1.5">{t.map((x) => <Badge key={x.name} tone="neutral" title={`${x.category} · ${Math.round(x.confidence * 100)}% confidence`}>{x.name}{x.version ? ` ${x.version}` : ""}</Badge>)}</div>;
}

export function evidenceById(inv: Investigation) { return new Map<string, Evidence>(inv.evidence.map((e) => [e.id, e])); }
