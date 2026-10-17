/** Monaco, bundled and served from this origin (workers included) — no CDN, works offline and inside the desktop app. */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};
monaco.languages.typescript.typescriptDefaults.setCompilerOptions({ target: monaco.languages.typescript.ScriptTarget.ESNext, jsx: monaco.languages.typescript.JsxEmit.ReactJSX, allowNonTsExtensions: true, moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs, noEmit: true, esModuleInterop: true, allowJs: true });
// We can't resolve node_modules in the browser, so "cannot find module" is noise, not a real problem.
for (const d of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) d.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: [2307, 2792, 7016, 2875, 7026] });
loader.config({ monaco });

export { monaco };
export const langOf = (path: string) => ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", json: "json", css: "css", scss: "scss", html: "html", md: "markdown", py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", swift: "swift", yml: "yaml", yaml: "yaml", toml: "ini", sh: "shell", sql: "sql", xml: "xml", svg: "xml", vue: "html", svelte: "html" } as Record<string, string>)[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
