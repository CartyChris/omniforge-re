import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import path from "node:path";
import fs from "node:fs";
import { ASSET_FILES, assembleAssets } from "../../packages/structure/assets.mjs";

/** Serves (dev) and emits (build) the tree-sitter runtime + grammars under /tree-sitter/, fetched by the analysis worker only when a repo has Python/Go/Java/Rust/C# source. */
function treeSitterAssets(): Plugin {
  return {
    name: "omniforge-tree-sitter-assets",
    configureServer(server) {
      server.middlewares.use("/tree-sitter", (req, res, next) => {
        const name = decodeURIComponent((req.url ?? "").split("?")[0]!.replace(/^\//, ""));
        if (!ASSET_FILES.includes(name)) return next();
        res.setHeader("content-type", "application/wasm"); res.setHeader("cache-control", "no-cache");
        fs.createReadStream(path.join(assembleAssets(path.resolve(__dirname, "../../packages/structure")), name)).pipe(res);
      });
    },
    generateBundle() {
      const dir = assembleAssets(path.resolve(__dirname, "../../packages/structure"));
      for (const name of ASSET_FILES) this.emitFile({ type: "asset", fileName: `tree-sitter/${name}`, source: fs.readFileSync(path.join(dir, name)) });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwind(), treeSitterAssets()],
  resolve: { alias: { "@codesandbox/nodebox": path.resolve(__dirname, "src/lib/nodebox-stub.ts"), "@": path.resolve(__dirname, "src") } }, // Nodebox: licence forbids our use; see nodebox-stub.ts
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } } },
  preview: { port: 5173, strictPort: true, proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } } },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router"],
          flow: ["@xyflow/react", "@dagrejs/dagre"],
          monaco: ["monaco-editor", "@monaco-editor/react"],
          sandpack: ["@codesandbox/sandpack-react"],
        },
      },
    },
  },
  worker: { format: "es" },
});
