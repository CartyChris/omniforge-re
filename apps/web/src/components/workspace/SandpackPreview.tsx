import { useMemo } from "react";
import { SandpackLayout, SandpackPreview as SPreview, SandpackProvider } from "@codesandbox/sandpack-react";
import { planSandpack } from "@omniforge/core";
import { useApp } from "@/lib/store";

/** Live React preview via Sandpack's bundler templates only (never the Nodebox-based "vite-*" ones). */
export default function SandpackPreview({ paths, get }: { paths: string[]; get: (p: string) => string | undefined }) {
  const theme = useApp((s) => s.settings.theme);
  const plan = useMemo(() => planSandpack(Object.fromEntries(paths.flatMap((p) => { const c = get(p); return c === undefined ? [] : [[p, c] as const]; }))), [paths, get]);
  return (
    <div className="flex h-full flex-col">
      <p className="border-b border-line px-3 py-1.5 text-xs text-muted">Live preview (Sandpack bundler). It loads from CodeSandbox's CDN, so this panel needs internet. For exact output run your dev server.</p>
      {plan.notes.length > 0 && <ul className="space-y-0.5 border-b border-line bg-warn/5 px-3 py-1.5 text-xs text-warn" data-testid="preview-notes">{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <SandpackProvider key={plan.entry + plan.template} template={plan.template} theme={theme === "dark" ? "dark" : "light"} files={plan.files} customSetup={{ entry: plan.entry, dependencies: plan.dependencies }} options={{ recompileMode: "delayed", recompileDelay: 600 }} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <SandpackLayout style={{ flex: 1, border: 0, borderRadius: 0, minHeight: 0 }}><SPreview style={{ height: "100%", flex: 1 }} showOpenInCodeSandbox={false} showRefreshButton /></SandpackLayout>
      </SandpackProvider>
    </div>
  );
}
