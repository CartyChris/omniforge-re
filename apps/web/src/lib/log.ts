/** In-app diagnostic log (ring buffer, kept in memory + the last 200 lines in sessionStorage). Never records secrets or content of analysed material. */
export interface LogLine { t: number; level: "info" | "warn" | "error"; src: string; msg: string }
const KEY = "omniforge.log";
let lines: LogLine[] = [];
const subs = new Set<() => void>();
try { lines = JSON.parse(sessionStorage.getItem(KEY) ?? "[]"); } catch { lines = []; }
const redact = (s: string) => s.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})/g, "[redacted]").slice(0, 1000);

export const appLog = {
  push(level: LogLine["level"], src: string, msg: string) {
    lines = [...lines.slice(-399), { t: Date.now(), level, src, msg: redact(msg) }];
    try { sessionStorage.setItem(KEY, JSON.stringify(lines.slice(-200))); } catch { /* blocked */ }
    subs.forEach((f) => f());
  },
  all: () => lines,
  clear() { lines = []; try { sessionStorage.removeItem(KEY); } catch { /* blocked */ } subs.forEach((f) => f()); },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};

export function installGlobalLogging() {
  window.addEventListener("error", (e) => appLog.push("error", "window", `${e.message} (${e.filename?.split("/").pop()}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => appLog.push("error", "promise", String((e.reason as Error)?.message ?? e.reason)));
}
