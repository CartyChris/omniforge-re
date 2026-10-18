/**
 * Plan for the in-browser React preview. Only Sandpack's bundler-based ("create-react-app" environment) templates are used:
 * the "vite-*" templates run on Nodebox, whose Sustainable Use License limits use to internal-business / non-commercial purposes.
 * A Vite project is adapted instead: its entry is passed explicitly, its root index.html becomes /public/index.html without the
 * module script tag, and build-tool packages are not installed in the browser.
 */
export interface SandpackPlan { template: "react" | "react-ts"; entry: string; files: Record<string, string>; dependencies: Record<string, string>; notes: string[] }

const ENTRIES = ["src/main.tsx", "src/index.tsx", "src/main.jsx", "src/index.jsx", "src/main.ts", "src/index.ts", "src/main.js", "src/index.js", "index.tsx", "index.jsx"];
const BUILD_TOOLS = /^(vite|@vitejs\/.*|typescript|@types\/.*|eslint.*|@eslint\/.*|prettier|vitest|jest|@testing-library\/.*|tailwindcss|postcss|autoprefixer|@tailwindcss\/.*|webpack.*|babel-.*|@babel\/.*|rollup.*|esbuild|tsx|ts-node|playwright.*|@playwright\/.*)$/;

export function planSandpack(input: Record<string, string>): SandpackPlan {
  const files: Record<string, string> = {}; const notes: string[] = [];
  for (const [p, c] of Object.entries(input)) if (!p.startsWith("node_modules/") && c.length < 400_000) files["/" + p] = c;
  const entryRel = ENTRIES.find((e) => files["/" + e] !== undefined) ?? "src/index.tsx";
  const ts = /\.(tsx?|mts)$/.test(entryRel) || Object.keys(files).some((f) => /\.tsx?$/.test(f));
  let deps: Record<string, string> = {};
  try { deps = (JSON.parse(files["/package.json"] ?? "{}").dependencies ?? {}) as Record<string, string>; } catch { notes.push("package.json is not valid JSON; default dependencies were used."); }
  const dependencies = Object.fromEntries(Object.entries(deps).filter(([k]) => !BUILD_TOOLS.test(k)));
  dependencies.react ??= "^18.2.0"; dependencies["react-dom"] ??= "^18.2.0";
  // Vite keeps index.html at the root with a module <script>; the bundler wants /public/index.html and injects the entry itself.
  const html = files["/index.html"];
  if (html && files["/public/index.html"] === undefined) files["/public/index.html"] = html.replace(/<script\b[^>]*type=["']module["'][^>]*>\s*<\/script>/gi, "");
  if (html && !/id=["']root["']/.test(html)) notes.push('index.html has no element with id="root"; the preview mounts into #root.');
  if (Object.values(files).some((c) => /import\.meta\.env|import\.meta\.glob/.test(c))) notes.push("Uses Vite-only features (import.meta.env / import.meta.glob) that the in-browser bundler does not provide — run the dev server for exact output.");
  if (files["/tailwind.config.js"] || files["/tailwind.config.ts"] || deps.tailwindcss) notes.push("Tailwind needs a build step the in-browser bundler does not run — styles may be missing; use the dev server.");
  return { template: ts ? "react-ts" : "react", entry: "/" + entryRel, files, dependencies, notes };
}
