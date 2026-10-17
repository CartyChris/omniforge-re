import * as React from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------------- Button ---------------- */
type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger" | "soft";
type Size = "xs" | "sm" | "md" | "lg" | "icon" | "icon-sm";
const V: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 active:brightness-95 shadow-[0_1px_0_0_rgb(255_255_255/0.18)_inset,0_6px_20px_-8px_color-mix(in_oklab,var(--accent)_70%,transparent)]",
  secondary: "bg-overlay text-fg hover:bg-line border border-line",
  soft: "bg-accent-soft text-accent hover:bg-[color-mix(in_oklab,var(--accent)_22%,transparent)]",
  ghost: "text-muted hover:text-fg hover:bg-overlay",
  outline: "border border-line-strong text-fg hover:bg-overlay",
  danger: "bg-bad/15 text-bad hover:bg-bad/25 border border-bad/30",
};
const S: Record<Size, string> = { xs: "h-7 px-2 text-xs gap-1.5 rounded-md", sm: "h-8 px-3 text-[13px] gap-1.5 rounded-lg", md: "h-9 px-3.5 text-sm gap-2 rounded-lg", lg: "h-11 px-5 text-[15px] gap-2 rounded-xl", icon: "h-9 w-9 rounded-lg", "icon-sm": "h-7 w-7 rounded-md" };
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; size?: Size; loading?: boolean; icon?: React.ReactNode }
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant = "secondary", size = "md", loading, icon, children, disabled, ...p }, ref) => (
  <button ref={ref} disabled={disabled || loading} className={cn("inline-flex shrink-0 select-none items-center justify-center font-medium transition-[background,filter,color,transform] duration-150 active:scale-[.98] disabled:pointer-events-none disabled:opacity-45", V[variant], S[size], className)} {...p}>
    {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
    {children}
  </button>
));
Button.displayName = "Button";

/* ---------------- Badge ---------------- */
type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info" | "teal";
const T: Record<Tone, string> = { neutral: "bg-overlay text-muted border-line", accent: "bg-accent-soft text-accent border-accent/25", ok: "bg-ok/10 text-ok border-ok/25", warn: "bg-warn/10 text-warn border-warn/25", bad: "bg-bad/10 text-bad border-bad/25", info: "bg-info/10 text-info border-info/25", teal: "bg-teal/10 text-teal border-teal/25" };
export function Badge({ tone = "neutral", dot, className, children, title }: { tone?: Tone; dot?: boolean; className?: string; children: React.ReactNode; title?: string }) {
  return <span title={title} className={cn("inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4", T[tone], className)}>{dot && <span className="size-1.5 shrink-0 rounded-full bg-current" />}<span className="truncate">{children}</span></span>;
}

/* ---------------- Card ---------------- */
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }>(({ className, interactive, ...p }, ref) => (
  <div ref={ref} className={cn("rounded-[var(--radius-card)] border border-line bg-surface", interactive && "cursor-pointer transition hover:border-line-strong hover:bg-elevated hover:shadow-[0_8px_30px_-12px_rgb(0_0_0/0.5)]", className)} {...p} />
));
Card.displayName = "Card";
export const CardHeader = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("flex items-center justify-between gap-3 border-b border-line px-4 py-3", className)} {...p} />;
export const CardTitle = ({ className, ...p }: React.HTMLAttributes<HTMLHeadingElement>) => <h3 className={cn("text-[13px] font-semibold tracking-tight text-fg", className)} {...p} />;
export const CardBody = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("p-4", className)} {...p} />;

/* ---------------- Inputs ---------------- */
const field = "w-full rounded-lg border border-line bg-bg px-3 text-sm text-fg placeholder:text-faint transition focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-50";
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => <input ref={ref} className={cn(field, "h-9", className)} {...p} />);
Input.displayName = "Input";
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => <textarea ref={ref} className={cn(field, "min-h-20 py-2 leading-relaxed", className)} {...p} />);
Textarea.displayName = "Textarea";
export function Field({ label, hint, children, className, group }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string; /** the child is a group of controls (e.g. a segmented picker): label it as a group instead of wrapping it in a <label> */ group?: boolean }) {
  const body = <><span className="text-xs font-medium text-muted">{label}</span>{children}{hint && <span className="block text-[11px] text-faint">{hint}</span>}</>;
  return group ? <div role="group" aria-label={label} className={cn("block space-y-1.5", className)}>{body}</div> : <label className={cn("block space-y-1.5", className)}>{body}</label>;
}

/* ---------------- misc ---------------- */
export const Kbd = ({ children, className }: { children: React.ReactNode; className?: string }) => <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-overlay px-1 font-mono text-[10px] font-medium text-muted", className)}>{children}</kbd>;
export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn("size-4 animate-spin text-muted", className)} aria-label="Loading" />;
export function Progress({ value, className, tone = "accent" }: { value: number; className?: string; tone?: "accent" | "ok" | "warn" | "bad" }) {
  const c = { accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" }[tone];
  return <div role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100} className={cn("h-1.5 w-full overflow-hidden rounded-full bg-overlay", className)}><div className={cn("h-full rounded-full transition-[width] duration-300", c)} style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} /></div>;
}
export const Skeleton = ({ className }: { className?: string }) => <div className={cn("relative overflow-hidden rounded-md bg-overlay before:absolute before:inset-0 before:-translate-x-full before:animate-[shimmer_1.4s_infinite] before:bg-gradient-to-r before:from-transparent before:via-line before:to-transparent", className)} />;
export function EmptyState({ icon, title, body, action, className }: { icon?: React.ReactNode; title: string; body?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-14 text-center", className)}>{icon && <div className="grid size-12 place-items-center rounded-2xl border border-line bg-elevated text-muted">{icon}</div>}<div className="space-y-1"><p className="text-sm font-medium text-fg">{title}</p>{body && <p className="mx-auto max-w-sm text-[13px] leading-relaxed text-muted">{body}</p>}</div>{action}</div>;
}
export function Stat({ label, value, sub, tone, icon }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; icon?: React.ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1"><div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">{icon}{label}</div><div className={cn("truncate text-2xl font-semibold tabular-nums tracking-tight", tone === "ok" && "text-ok", tone === "warn" && "text-warn", tone === "bad" && "text-bad", tone === "accent" && "text-accent")}>{value}</div>{sub && <div className="truncate text-xs text-muted">{sub}</div>}</div>;
}
export function Segmented<T extends string>({ value, onChange, options, className, size = "md" }: { value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode; title?: string }[]; className?: string; size?: "sm" | "md" }) {
  return <div role="radiogroup" className={cn("inline-flex rounded-lg border border-line bg-bg p-0.5", className)}>{options.map((o) => <button key={o.value} role="radio" aria-checked={value === o.value} title={o.title} onClick={() => onChange(o.value)} className={cn("rounded-md font-medium transition", size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-[13px]", value === o.value ? "bg-overlay text-fg shadow-sm" : "text-muted hover:text-fg")}>{o.label}</button>)}</div>;
}
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = React.useState(false);
  return <Button size="xs" variant="ghost" className={className} aria-label={label || "Copy"} icon={done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />} onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* clipboard blocked */ } }}>{done ? "Copied" : label}</Button>;
}
export function SectionTitle({ title, sub, right, className }: { title: string; sub?: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}><div className="min-w-0"><h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>{sub && <p className="mt-1 max-w-2xl text-sm text-muted">{sub}</p>}</div>{right && <div className="flex items-center gap-2">{right}</div>}</div>;
}
/** Status dot with optional pulse */
export function StatusDot({ tone, pulse }: { tone: "ok" | "warn" | "bad" | "idle" | "info"; pulse?: boolean }) {
  const c = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-faint", info: "bg-info" }[tone];
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", c, pulse && "animate-[pulse-dot_1.4s_ease-in-out_infinite]")} />;
}
