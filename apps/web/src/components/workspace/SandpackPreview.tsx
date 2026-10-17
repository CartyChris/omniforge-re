import { useMemo } from "react";
import { SandpackLayout, SandpackPreview as SPreview, SandpackProvider } from "@codesandbox/sandpack-react";
import { useApp } from "@/lib/store";

/** Live React preview via Sandpack. Note: Sandpack's in-browser bundler is fetched from CodeSandbox's CDN. */
export default function SandpackPreview({ paths, get }: { paths: string[]; get: (p: string) => string | undefined }) {
  const theme = useApp((s) => s.settings.theme);
  const { files, deps } = useMemo(() => {
    const files: Record<string, string> = {}; for (const p of paths) { const c = get(p); if (c !== undefined && c.length < 400_000 && !p.startsWith("node_modules/")) files["/" + p] = c; }
    let deps: Record<string, string> = {}; try { const j = JSON.parse(files["/package.json"] ?? "{}"); deps = { ...j.dependencies, ...j.devDependencies }; } catch { /* use defaults */ }
    return { files, deps };
  }, [paths, get]);
  const template = files["/src/main.tsx"] || files["/src/index.tsx"] ? "vite-react-ts" : files["/src/main.jsx"] || files["/src/index.jsx"] ? "vite-react" : "react-ts";
  return (
    <div className="flex h-full flex-col"><p className="border-b border-line px-3 py-1.5 text-xs text-muted">Live preview (Sandpack). Its bundler loads from CodeSandbox's CDN, so this panel needs internet.</p>
      <SandpackProvider template={template} theme={theme === "dark" ? "dark" : "light"} files={files} customSetup={{ dependencies: deps }} options={{ recompileMode: "delayed", recompileDelay: 600 }} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <SandpackLayout style={{ flex: 1, border: 0, borderRadius: 0, minHeight: 0 }}><SPreview style={{ height: "100%", flex: 1 }} showOpenInCodeSandbox={false} showRefreshButton /></SandpackLayout>
      </SandpackProvider>
    </div>
  );
}
