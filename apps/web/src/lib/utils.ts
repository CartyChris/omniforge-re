import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...i: ClassValue[]) => twMerge(clsx(i));
export const fmtBytes = (n?: number) => (n === undefined ? "—" : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
export const fmtNum = (n: number) => new Intl.NumberFormat("en").format(n);
export const pct = (x: number) => `${Math.round(x * 100)}%`;
export function ago(iso?: string | number) {
  if (!iso) return "never";
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };
export const pathOf = (u: string) => { try { const x = new URL(u); return (x.pathname || "/") + x.search; } catch { return u; } };
export function download(name: string, data: Blob | Uint8Array | string, type = "application/octet-stream") {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number) { let t: ReturnType<typeof setTimeout>; const d = ((...a: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T & { flush(): void }; d.flush = () => clearTimeout(t); return d; }
