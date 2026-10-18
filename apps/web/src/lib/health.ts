/** Setup check: every line is a real probe (nothing is assumed). Used by Integrations → Setup & diagnostics and saved as a report. */
import { github, vercel } from "@omniforge/core";
import { useApp } from "./store";
import { ghToken, ghOpts, vcOpts, vcToken } from "./github";
import { db } from "./storage";

export interface HealthCheck { id: string; label: string; status: "pass" | "warn" | "fail" | "skip"; detail: string; fix?: string }
const guard = async (id: string, label: string, f: () => Promise<Omit<HealthCheck, "id" | "label">>): Promise<HealthCheck> => { try { return { id, label, ...(await f()) }; } catch (e) { return { id, label, status: "fail", detail: (e as Error).message }; } };

export async function runHealthCheck(): Promise<HealthCheck[]> {
  const st = useApp.getState(); const b = st.bridgeInfo; const out: Promise<HealthCheck>[] = [];
  const c = (id: string, label: string, f: () => Promise<Omit<HealthCheck, "id" | "label">>) => out.push(guard(id, label, f));

  c("storage", "Browser storage", async () => db.persistent() ? { status: "pass", detail: "Projects are saved in this browser." } : { status: "warn", detail: "Storage is unavailable (private window?). Work lives in memory only.", fix: "Use a normal window, and back up from Settings → Data." });
  if (st.bridgeState === "connected" && b && st.bridge) {
    const bridge = st.bridge;
    c("engine", "Local engine", async () => { await bridge.get("/bridge/info"); return { status: "pass", detail: `Answering (v${b.version}).` }; });
    c("arch", "Architecture", async () => b.system.rosetta ? { status: "warn", detail: `Running under Rosetta (${b.system.arch} on ${b.system.nativeArch}).`, fix: "Install the Apple Silicon build for full speed." } : { status: "pass", detail: `${b.system.platform} ${b.system.arch}${b.system.appleSilicon ? " (Apple Silicon)" : ""}, ${b.system.cpus} cores, ${b.system.memTotalGB} GB RAM.` });
    const tool = (id: string, label: string, needed: boolean) => c(`tool:${id}`, label, async () => { const t = b.tools.find((x) => x.id === id); return t?.status === "found" ? { status: "pass", detail: `${t.version ?? "found"}${t.path ? ` — ${t.path}` : ""}` } : { status: needed ? "fail" : "warn", detail: t ? `${t.status}${t.detail ? `: ${t.detail}` : ""}` : "not detected", fix: t?.install }; });
    tool("git", "git", true); tool("node", "Node.js", false); tool("npm", "npm", false);
    c("render", "Page rendering (Chrome/Chromium)", async () => b.chrome ? { status: "pass", detail: b.chrome } : { status: "warn", detail: "No Chrome/Chromium found; analysis falls back to static HTML.", fix: "Install Google Chrome." });
    c("clis", "AI command-line tools", async () => { const ok = b.clis.filter((x: any) => x.verified); return b.clis.length ? { status: ok.length ? "pass" : "warn", detail: `${b.clis.length} found, ${ok.length} verified working${ok.length ? ` (${ok.map((x: any) => x.id).join(", ")})` : ""}.` } : { status: "skip", detail: "None installed (optional)." }; });
    c("local", "Local model runtimes", async () => { const up = b.runtimes.services.filter((s: any) => s.status === "reachable"); return up.length ? { status: "pass", detail: up.map((s: any) => s.presetId).join(", ") } : { status: "skip", detail: "None running (optional: Ollama, LM Studio, llama.cpp)." }; });
    c("rea", "REA (app inspection)", async () => { const s = b.rea?.status ?? (b.rea?.found ? "found" : "missing"); return s === "ready" || s === "found" ? { status: "pass", detail: "Available." } : { status: "skip", detail: `${s} (optional; needed only to inspect installed apps).` }; });
  } else c("engine", "Local engine", async () => ({ status: "skip", detail: "Web version — folder access, CLIs, git and local rendering need the macOS app." }));

  c("providers", "AI providers", async () => st.models.length ? { status: "pass", detail: `${st.models.length} models from ${new Set(st.models.map((m) => m.provider)).size} provider(s).` } : { status: st.providers.length ? "fail" : "warn", detail: st.modelErrors.length ? st.modelErrors.map((e) => `${e.provider}: ${e.error}`).join("; ").slice(0, 300) : "No provider connected.", fix: "Add one in AI Studio → Providers." });
  c("github", "GitHub", async () => { if (!(await ghToken())) return { status: "skip", detail: "Not connected." }; const me = await github.whoami(await ghOpts()); return { status: "pass", detail: `Token works (signed in as ${me.login}).` }; });
  c("vercel", "Vercel", async () => { if (!(await vcToken())) return { status: "skip", detail: "Not connected." }; const t = await vercel.listTeams(await vcOpts()); return { status: "pass", detail: `Token works (${t.length} team${t.length === 1 ? "" : "s"}).` }; });
  return Promise.all(out);
}
