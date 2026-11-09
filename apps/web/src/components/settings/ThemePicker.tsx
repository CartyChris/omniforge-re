import { Check, Monitor, Moon, Sun } from "lucide-react";
import { ACCENTS, THEMES, resolveTheme, themeVars } from "@/lib/themes";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/primitives";

/** Appearance: quick mode, a grid of themes drawn in their own colours, and accent swatches (all keyboard-accessible radios). */
export function ThemePicker() {
  const { settings, patchSettings } = useApp();
  const current = settings.themeId ?? settings.theme;
  const mode = current === "system" ? "system" : current === "light" ? "light" : current === "dark" ? "dark" : "custom";
  const effective = resolveTheme(current);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-sm font-medium">Theme</p><p className="text-xs text-muted">Applies instantly and is remembered on this device. Every theme and accent meets WCAG AA contrast.</p></div>
        <div role="group" aria-label="Quick theme"><Segmented size="sm" value={mode} onChange={(v) => v !== "custom" && patchSettings({ themeId: v })} options={[{ value: "dark", label: <span className="flex items-center gap-1.5"><Moon className="size-3.5" />Dark</span> }, { value: "light", label: <span className="flex items-center gap-1.5"><Sun className="size-3.5" />Light</span> }, { value: "system", label: <span className="flex items-center gap-1.5"><Monitor className="size-3.5" />System</span> }]} /></div>
      </div>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {THEMES.map((t) => {
          const { vars } = themeVars(t.id, settings.accent); const on = effective.id === t.id && current !== "system";
          return (
            <button key={t.id} role="radio" aria-checked={on} aria-label={`${t.label} theme`} onClick={() => patchSettings({ themeId: t.id })}
              className={cn("group overflow-hidden rounded-xl border text-left transition focus-visible:outline-2", on ? "border-accent ring-2 ring-accent/40" : "border-line hover:border-line-strong")}>
              <div className="flex h-14 gap-1.5 p-2" style={{ background: vars.bg }} aria-hidden>
                <div className="w-1/4 rounded-md" style={{ background: vars.surface, border: `1px solid ${vars.line}` }} />
                <div className="flex flex-1 flex-col gap-1 rounded-md p-1.5" style={{ background: vars.surface, border: `1px solid ${vars.line}` }}>
                  <div className="h-1.5 w-3/4 rounded-full" style={{ background: vars.fg }} /><div className="h-1.5 w-1/2 rounded-full" style={{ background: vars.muted }} />
                  <div className="mt-auto h-2 w-8 rounded-full" style={{ background: vars.accent }} />
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-line bg-surface px-2.5 py-1.5 text-[12px] font-medium"><span className="truncate">{t.label}</span>{on && <Check className="size-3.5 shrink-0 text-accent" aria-hidden />}</div>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs font-medium text-muted">Accent colour</p>
        <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap gap-1.5">
          <button role="radio" aria-checked={!settings.accent} onClick={() => patchSettings({ accent: null })} className={cn("h-8 rounded-full border px-3 text-xs font-medium", !settings.accent ? "border-accent bg-accent-soft text-fg" : "border-line text-muted hover:text-fg")}>Theme default</button>
          {ACCENTS.map((a) => { const on = settings.accent === a.id; const c = a[effective.mode]; return (
            <button key={a.id} role="radio" aria-checked={on} aria-label={`${a.label} accent`} title={a.label} onClick={() => patchSettings({ accent: a.id })}
              className={cn("grid size-8 place-items-center rounded-full border-2 transition", on ? "border-fg" : "border-transparent hover:border-line-strong")}>
              <span className="grid size-6 place-items-center rounded-full" style={{ background: c.accent, color: c.fg }}>{on && <Check className="size-3.5" aria-hidden />}</span>
            </button>
          ); })}
        </div>
      </div>
    </div>
  );
}
