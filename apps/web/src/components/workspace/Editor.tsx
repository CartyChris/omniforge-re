import { useEffect, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { langOf } from "@/lib/monaco";
import { useApp } from "@/lib/store";
import { Spinner } from "@/components/ui/primitives";

const opts = { fontSize: 13, fontFamily: "'JetBrains Mono Variable', ui-monospace, Menlo, monospace", minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, renderWhitespace: "selection" as const, padding: { top: 12 }, smoothScrolling: true, bracketPairColorization: { enabled: true }, wordWrap: "off" as const };

export function CodeEditor({ path, value, onChange, readOnly, onMarkers }: { path: string; value: string; onChange: (v: string) => void; readOnly?: boolean; onMarkers?: (m: { path: string; line: number; col: number; severity: "error" | "warning" | "info"; message: string }[]) => void }) {
  const theme = useApp((s) => s.settings.theme);
  return (
    <Editor key={path} path={path} language={langOf(path)} value={value} theme={theme === "dark" ? "vs-dark" : "light"} loading={<div className="grid h-full place-items-center"><Spinner /></div>} options={{ ...opts, readOnly }}
      onChange={(v) => onChange(v ?? "")}
      onValidate={(markers) => onMarkers?.(markers.map((m) => ({ path, line: m.startLineNumber, col: m.startColumn, severity: m.severity >= 8 ? "error" : m.severity >= 4 ? "warning" : "info", message: m.message })))} />
  );
}

export function DiffView({ path, original, modified, onChange }: { path: string; original: string; modified: string; onChange?: (v: string) => void }) {
  const theme = useApp((s) => s.settings.theme);
  const [inline, setInline] = useState(false);
  useEffect(() => { const f = () => setInline(window.innerWidth < 900); f(); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  return <DiffEditor key={path} original={original} modified={modified} language={langOf(path)} theme={theme === "dark" ? "vs-dark" : "light"} loading={<div className="grid h-full place-items-center"><Spinner /></div>} options={{ ...opts, renderSideBySide: !inline, originalEditable: false }} onMount={(ed) => { ed.getModifiedEditor().onDidChangeModelContent(() => onChange?.(ed.getModifiedEditor().getValue())); }} />;
}
