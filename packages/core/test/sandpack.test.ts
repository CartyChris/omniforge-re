import { describe, expect, it } from "vitest";
import { planSandpack } from "../src/preview/sandpack";

const vite = {
  "package.json": JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", "lucide-react": "^0.400.0" }, devDependencies: { vite: "^7", "@vitejs/plugin-react": "^5", typescript: "^5", "@types/react": "^19" } }),
  "index.html": '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  "src/main.tsx": 'import { createRoot } from "react-dom/client"; createRoot(document.getElementById("root")!).render(<h1>Hi</h1>);', "src/App.tsx": "export default function App(){return null}",
};

describe("planSandpack", () => {
  it("never selects a Nodebox-based (vite-*) template — a bundler template with an explicit entry instead", () => {
    const p = planSandpack(vite);
    expect(p.template).toBe("react-ts");
    expect(["react", "react-ts"]).toContain(p.template); // 'vite-react*' templates run on Nodebox (non-commercial licence)
    expect(p.entry).toBe("/src/main.tsx");
  });
  it("adapts Vite's index.html: no module script, placed in /public", () => {
    const p = planSandpack(vite);
    expect(p.files["/public/index.html"]).toContain('<div id="root">'); expect(p.files["/public/index.html"]).not.toMatch(/<script/);
    expect(p.files["/index.html"]).toMatch(/<script type="module"/); // original untouched
    const own = planSandpack({ ...vite, "public/index.html": "<div id=root></div><!-- mine -->" });
    expect(own.files["/public/index.html"]).toContain("mine"); // an existing public/index.html wins
  });
  it("installs runtime dependencies only (no Vite/TypeScript/@types in the browser), defaulting React", () => {
    const p = planSandpack(vite);
    expect(p.dependencies).toEqual({ react: "^19.0.0", "react-dom": "^19.0.0", "lucide-react": "^0.400.0" });
    expect(planSandpack({ "src/index.js": "x" }).dependencies).toMatchObject({ react: "^18.2.0", "react-dom": "^18.2.0" });
    expect(planSandpack({ "package.json": JSON.stringify({ dependencies: { vite: "^7", tailwindcss: "^4", react: "^18.0.0" } }), "src/index.js": "x" }).dependencies).toEqual({ react: "^18.0.0", "react-dom": "^18.2.0" });
  });
  it("picks the JS template for JS-only projects, finds jsx entries, and survives bad package.json", () => {
    const p = planSandpack({ "src/main.jsx": "x", "src/App.jsx": "y", "package.json": "{nope" });
    expect(p).toMatchObject({ template: "react", entry: "/src/main.jsx" });
    expect(p.notes.join()).toMatch(/not valid JSON/);
  });
  it("warns about Vite-only features and Tailwind instead of silently rendering wrong", () => {
    const p = planSandpack({ ...vite, "src/App.tsx": "const k = import.meta.env.VITE_KEY;", "tailwind.config.js": "module.exports={}" });
    expect(p.notes.join("|")).toMatch(/import\.meta\.env/); expect(p.notes.join("|")).toMatch(/Tailwind/);
  });
  it("skips node_modules and oversized files", () => {
    const p = planSandpack({ ...vite, "node_modules/x/index.js": "x", "big.js": "x".repeat(400_001) });
    expect(Object.keys(p.files).some((f) => f.includes("node_modules") || f === "/big.js")).toBe(false);
  });
});
