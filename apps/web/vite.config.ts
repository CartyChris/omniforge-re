import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwind()],
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
