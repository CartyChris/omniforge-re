/** Desktop-only glue: native menu events from the Tauri shell. No-op in a browser. */
import { isTauri } from "./bridge";
import { useApp } from "./store";

export async function initDesktop(navigate: (to: string) => void) {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un1 = await listen<string>("menu:navigate", (e) => navigate(e.payload));
  const un2 = await listen<string>("menu:action", (e) => {
    if (e.payload === "export-project") { const bytes = useApp.getState().exportActive(); if (bytes) { import("./utils").then(({ download }) => download(`${useApp.getState().project?.name ?? "project"}.omniforge.zip`, bytes, "application/zip")); } }
  });
  return () => { for (const u of [un1, un2]) { try { u(); } catch { /* shell already gone */ } } };
}
