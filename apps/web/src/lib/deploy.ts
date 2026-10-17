import { redactSecrets } from "@omniforge/core";
import { useApp } from "./store";

export interface ProbeResult { ok: boolean; status: number; ms: number; finalUrl?: string; title?: string; vercel?: boolean; protected?: boolean; error?: string }

/** Ask a server (hosted function or the desktop companion) to fetch the URL: browsers can't read cross-origin status codes. */
export async function probeUrl(url: string): Promise<ProbeResult> {
  const { bridge, settings } = useApp.getState();
  const res = bridge && settings.preferBridge ? await bridge.raw("POST", "/bridge/probe", { url }) : await fetch("/api/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error ?? `Verification service error ${res.status}`); }
  return res.json();
}

export interface Check { id: string; label: string; status: "pass" | "warn" | "fail"; detail: string }

const FRAMEWORKS: [RegExp, string, string][] = [[/"next"\s*:/, "nextjs", "Next.js"], [/"@sveltejs\/kit"\s*:/, "sveltekit-1", "SvelteKit"], [/"nuxt"\s*:/, "nuxtjs", "Nuxt"], [/"astro"\s*:/, "astro", "Astro"], [/"@remix-run\/[a-z-]+"\s*:/, "remix", "Remix"], [/"gatsby"\s*:/, "gatsby", "Gatsby"], [/"react-scripts"\s*:/, "create-react-app", "Create React App"], [/"vite"\s*:/, "vite", "Vite"]];
export function detectFramework(files: Record<string, string>): { id: string | null; label: string; output?: string } {
  const pkg = files["package.json"];
  if (pkg) for (const [re, id, label] of FRAMEWORKS) if (re.test(pkg)) return { id, label };
  if (pkg) return { id: null, label: "Node project (custom build)" };
  if (files["index.html"]) return { id: null, label: "Static site", output: "." };
  return { id: null, label: "Unknown" };
}

/** Failable pre-flight: each check can block a deploy/push. */
export function preflight(files: Record<string, string>): Check[] {
  const paths = Object.keys(files); const checks: Check[] = [];
  checks.push(paths.length ? { id: "files", label: "Project has files", status: "pass", detail: `${paths.length} files` } : { id: "files", label: "Project has files", status: "fail", detail: "The workspace is empty — build or import something first." });
  const envFiles = paths.filter((p) => /(^|\/)\.env(\.|$)/.test(p) && !/\.example$|\.sample$|\.template$/.test(p));
  checks.push(envFiles.length ? { id: "env", label: "No .env files", status: "fail", detail: `Remove ${envFiles.slice(0, 3).join(", ")} — secrets must not be published. Use .env.example with names only.` } : { id: "env", label: "No .env files", status: "pass", detail: "None found" });
  const leaks: string[] = [];
  for (const [p, c] of Object.entries(files)) { if (c.length > 2_000_000 || /(^|\/)\.env\.(example|sample|template)$/.test(p)) continue; const r = redactSecrets(c); if (r.found.length) leaks.push(`${p} (${[...new Set(r.found)].join(", ")})`); }
  checks.push(leaks.length ? { id: "secrets", label: "No secrets in code", status: "fail", detail: `Possible secrets in ${leaks.slice(0, 4).join("; ")}${leaks.length > 4 ? ` +${leaks.length - 4} more` : ""}. Replace them with environment variables.` } : { id: "secrets", label: "No secrets in code", status: "pass", detail: "Scanned every text file" });
  const bytes = Object.values(files).reduce((n, c) => n + c.length, 0);
  checks.push(bytes > 50_000_000 ? { id: "size", label: "Size", status: "fail", detail: "Over 50 MB — too large to upload from the browser." } : { id: "size", label: "Size", status: "pass", detail: `${(bytes / 1e6).toFixed(1)} MB` });
  const fw = detectFramework(files);
  checks.push(fw.label === "Unknown" ? { id: "fw", label: "Deployable app", status: "warn", detail: "No package.json or index.html found — Vercel may not know how to build this." } : { id: "fw", label: "Deployable app", status: "pass", detail: fw.label });
  if (files["package.json"] && !/"build"\s*:/.test(files["package.json"]) && fw.id) checks.push({ id: "build", label: "Build script", status: "warn", detail: "package.json has no build script." });
  return checks;
}
export const blocked = (c: Check[]) => c.some((x) => x.status === "fail");
