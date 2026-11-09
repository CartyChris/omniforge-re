/**
 * Themes and accent colours. One source of truth: applying a theme writes CSS variables on <html> (the stylesheet's
 * dark/light blocks stay as the no-JS defaults) and caches them so /theme-init.js can apply them before first paint.
 * Every theme × accent combination must meet the contrast minimums in CONTRAST (checked in e2e on the rendered page).
 */
import { ls } from "./storage";

export type Mode = "dark" | "light";
export type Var = "bg" | "surface" | "elevated" | "overlay" | "line" | "line-strong" | "fg" | "muted" | "faint" | "teal" | "ok" | "warn" | "bad" | "info";
export interface ThemeDef { id: string; label: string; mode: Mode; accent: string; vars: Record<Var, string> }
export interface AccentDef { id: string; label: string; dark: { accent: string; fg: string }; light: { accent: string; fg: string } }

const STATUS = { dark: { teal: "#2dd4bf", ok: "#4ade80", warn: "#fbbf24", bad: "#f87171", info: "#60a5fa" }, light: { teal: "#0d9488", ok: "#15803d", warn: "#b45309", bad: "#dc2626", info: "#2563eb" } } as const;

export const THEMES: ThemeDef[] = [
  { id: "dark", label: "OmniForge Dark", mode: "dark", accent: "violet", vars: { bg: "#090b10", surface: "#0f1219", elevated: "#151923", overlay: "#1a1f2b", line: "#1f2430", "line-strong": "#2b3242", fg: "#e8eaf0", muted: "#9097a9", faint: "#838898", ...STATUS.dark } },
  { id: "light", label: "OmniForge Light", mode: "light", accent: "violet", vars: { bg: "#f6f7fa", surface: "#ffffff", elevated: "#ffffff", overlay: "#f0f2f7", line: "#e4e7ee", "line-strong": "#cfd4df", fg: "#12141a", muted: "#596073", faint: "#676d7b", ...STATUS.light } },
  { id: "midnight", label: "Midnight", mode: "dark", accent: "blue", vars: { bg: "#070b16", surface: "#0c1222", elevated: "#111a2e", overlay: "#16203a", line: "#1c2741", "line-strong": "#2a3757", fg: "#e6ecff", muted: "#97a3c6", faint: "#7e89a6", ...STATUS.dark } },
  { id: "nord", label: "Nord", mode: "dark", accent: "cyan", vars: { bg: "#2a303b", surface: "#2e3440", elevated: "#353c4a", overlay: "#3b4252", line: "#3b4252", "line-strong": "#4c566a", fg: "#eceff4", muted: "#c3cbd9", faint: "#a8b0c0", teal: "#8fbcbb", ok: "#a3be8c", warn: "#ebcb8b", bad: "#ec8c94", info: "#81a1c1" } },
  { id: "dracula", label: "Dracula", mode: "dark", accent: "pink", vars: { bg: "#1e1f29", surface: "#282a36", elevated: "#2e3040", overlay: "#363848", line: "#343746", "line-strong": "#44475a", fg: "#f8f8f2", muted: "#b9bcd0", faint: "#a0a3bb", teal: "#8be9fd", ok: "#50fa7b", warn: "#f1fa8c", bad: "#ff6e6e", info: "#8be9fd" } },
  { id: "solarized-dark", label: "Solarized Dark", mode: "dark", accent: "blue", vars: { bg: "#002b36", surface: "#06323e", elevated: "#0a3a47", overlay: "#0f4250", line: "#0f4250", "line-strong": "#1c5563", fg: "#eee8d5", muted: "#a9b7b8", faint: "#9baca8", teal: "#2aa198", ok: "#9bbf3a", warn: "#d9a521", bad: "#f0625c", info: "#5aa9e6" } },
  { id: "forest", label: "Forest", mode: "dark", accent: "green", vars: { bg: "#08110c", surface: "#0e1812", elevated: "#131f18", overlay: "#19281f", line: "#1b2a21", "line-strong": "#2a3b30", fg: "#e3efe6", muted: "#98ad9f", faint: "#7f9385", ...STATUS.dark } },
  { id: "high-contrast-dark", label: "High contrast (dark)", mode: "dark", accent: "amber", vars: { bg: "#000000", surface: "#0a0a0a", elevated: "#121212", overlay: "#1c1c1c", line: "#6b6b6b", "line-strong": "#9a9a9a", fg: "#ffffff", muted: "#dcdcdc", faint: "#b0b0b0", teal: "#5eead4", ok: "#6ee7a0", warn: "#ffd54a", bad: "#ff8a8a", info: "#8ec5ff" } },
  { id: "solarized-light", label: "Solarized Light", mode: "light", accent: "blue", vars: { bg: "#fdf6e3", surface: "#fffbf0", elevated: "#fffdf7", overlay: "#f3ecd6", line: "#e8e0c8", "line-strong": "#d3cab0", fg: "#073642", muted: "#4d5f66", faint: "#536e73", teal: "#1b7f78", ok: "#5b7a00", warn: "#9a6200", bad: "#c4302b", info: "#1f6fb2" } },
  { id: "paper", label: "Paper", mode: "light", accent: "orange", vars: { bg: "#f4eedf", surface: "#fbf7ec", elevated: "#fffbf2", overlay: "#ece4cf", line: "#e2d8bd", "line-strong": "#cdbf9c", fg: "#2b2318", muted: "#5c513f", faint: "#6e634e", teal: "#0f766e", ok: "#3f6d1f", warn: "#9a5a00", bad: "#b42318", info: "#1d5fa8" } },
  { id: "high-contrast-light", label: "High contrast (light)", mode: "light", accent: "blue", vars: { bg: "#ffffff", surface: "#ffffff", elevated: "#ffffff", overlay: "#efefef", line: "#6b6b6b", "line-strong": "#3d3d3d", fg: "#000000", muted: "#262626", faint: "#4d4d4d", teal: "#0b5f59", ok: "#0b6b2e", warn: "#7a4a00", bad: "#b00020", info: "#0b4fb3" } },
];

export const ACCENTS: AccentDef[] = [
  { id: "violet", label: "Violet", dark: { accent: "#9d8fff", fg: "#0b0a1a" }, light: { accent: "#5b45f0", fg: "#ffffff" } },
  { id: "blue", label: "Blue", dark: { accent: "#7fb2ff", fg: "#06142b" }, light: { accent: "#1d5fd6", fg: "#ffffff" } },
  { id: "cyan", label: "Cyan", dark: { accent: "#67d8ef", fg: "#04222a" }, light: { accent: "#0b6f86", fg: "#ffffff" } },
  { id: "teal", label: "Teal", dark: { accent: "#4fe0c8", fg: "#032621" }, light: { accent: "#0b7268", fg: "#ffffff" } },
  { id: "green", label: "Green", dark: { accent: "#6fe39a", fg: "#052512" }, light: { accent: "#16753a", fg: "#ffffff" } },
  { id: "amber", label: "Amber", dark: { accent: "#ffcf5c", fg: "#2a1c00" }, light: { accent: "#8a5300", fg: "#ffffff" } },
  { id: "orange", label: "Orange", dark: { accent: "#ffa266", fg: "#2b1200" }, light: { accent: "#a8460f", fg: "#ffffff" } },
  { id: "red", label: "Red", dark: { accent: "#ff8f8f", fg: "#2b0606" }, light: { accent: "#c0262d", fg: "#ffffff" } },
  { id: "pink", label: "Pink", dark: { accent: "#ff8ccf", fg: "#2b0619" }, light: { accent: "#b51d7b", fg: "#ffffff" } },
  { id: "mono", label: "Monochrome", dark: { accent: "#e8eaf0", fg: "#0b0c10" }, light: { accent: "#1f2329", fg: "#ffffff" } },
];

/** WCAG minimums every combination must meet (rendered colours are checked in e2e). */
export const CONTRAST: { fg: Var | "accent" | "accent-fg"; bg: Var | "accent"; min: number }[] = [
  { fg: "fg", bg: "bg", min: 7 }, { fg: "fg", bg: "surface", min: 7 },
  { fg: "muted", bg: "bg", min: 4.5 }, { fg: "muted", bg: "surface", min: 4.5 }, { fg: "muted", bg: "elevated", min: 4.5 },
  { fg: "accent", bg: "bg", min: 4.5 }, { fg: "accent", bg: "surface", min: 4.5 }, { fg: "accent-fg", bg: "accent", min: 4.5 },
  // "faint" is used for real text (stat labels, hints, placeholders), so it must meet AA too
  ...(["bg", "surface", "elevated", "overlay"] as const).map((bg) => ({ fg: "faint" as const, bg, min: 4.5 })),
  ...(["ok", "warn", "bad", "info", "teal"] as const).map((v) => ({ fg: v, bg: "surface" as const, min: 3 })),
];

export const themeById = (id: string | undefined) => THEMES.find((t) => t.id === id) ?? THEMES[0]!;
export const accentById = (id: string | undefined | null) => ACCENTS.find((a) => a.id === id);
export const systemMode = (): Mode => (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
/** "system" follows the OS between the two OmniForge themes. */
export const resolveTheme = (id: string | undefined) => (id === "system" ? themeById(systemMode()) : themeById(id));

export function themeVars(themeId: string | undefined, accentId?: string | null): { mode: Mode; vars: Record<string, string> } {
  const t = resolveTheme(themeId); const a = accentById(accentId) ?? accentById(t.accent)!;
  const ac = a[t.mode];
  const vars: Record<string, string> = { ...t.vars, accent: ac.accent, "accent-fg": ac.fg, "accent-soft": `color-mix(in oklab, ${ac.accent} ${t.mode === "dark" ? 16 : 11}%, transparent)` };
  return { mode: t.mode, vars };
}

/** Apply to the document and cache for the pre-paint script. */
export function applyTheme(themeId: string | undefined, accentId?: string | null): Mode {
  const { mode, vars } = themeVars(themeId, accentId);
  const el = document.documentElement;
  el.setAttribute("data-theme", mode); el.setAttribute("data-palette", resolveTheme(themeId).id);
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(`--${k}`, v);
  ls.setRaw("omniforge.theme", mode); ls.setRaw("omniforge.themeVars", JSON.stringify(vars));
  return mode;
}

/* ---- WCAG contrast (used by the e2e check and the Settings preview) ---- */
export function parseColor(c: string): [number, number, number] | null {
  const h = c.trim().match(/^#([0-9a-f]{6})$/i); if (h) return [0, 2, 4].map((i) => parseInt(h[1]!.slice(i, i + 2), 16)) as [number, number, number];
  const m = c.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const lum = ([r, g, b]: [number, number, number]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
export function contrastRatio(a: string, b: string): number { const x = parseColor(a), y = parseColor(b); if (!x || !y) return 0; const l1 = lum(x), l2 = lum(y); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
