/**
 * Turn a set of source files (upload, archive, cloned repo, local folder) into
 * the same Investigation shape a website crawl produces, so the UI, reports,
 * feature library and agents treat every input type uniformly.
 */
import { DEFAULT_CRAWL } from "../schema.js";
import type { Evidence, Feature, Finding, Investigation, Technology } from "../schema.js";
import { hashStr, now, uid } from "../util/index.js";
import { analyzeSourceTree, type InputFile, type SourceTreeAnalysis } from "./source.js";
import { capSymbols, routeEndpoints, structureCandidates, type StructureExtractor, type StructureResult } from "./structure.js";
import { fingerprint, mergeTechnologies } from "./fingerprint.js";
import { analyzeTechnicalArtifacts } from "./artifacts.js";

const DEP_TECH: Record<string, { name: string; category: string }> = {
  react: { name: "React", category: "JavaScript framework" }, next: { name: "Next.js", category: "Web framework" }, vue: { name: "Vue.js", category: "JavaScript framework" },
  nuxt: { name: "Nuxt", category: "Web framework" }, "@angular/core": { name: "Angular", category: "JavaScript framework" }, svelte: { name: "Svelte", category: "JavaScript framework" },
  "@sveltejs/kit": { name: "SvelteKit", category: "Web framework" }, astro: { name: "Astro", category: "Web framework" }, vite: { name: "Vite", category: "Bundler" },
  webpack: { name: "Webpack", category: "Bundler" }, tailwindcss: { name: "Tailwind CSS", category: "CSS framework" }, express: { name: "Express", category: "Web framework" },
  fastify: { name: "Fastify", category: "Web framework" }, "@nestjs/core": { name: "NestJS", category: "Web framework" }, "@tauri-apps/api": { name: "Tauri", category: "Desktop framework" },
  electron: { name: "Electron", category: "Desktop framework" }, "@prisma/client": { name: "Prisma", category: "ORM" }, "drizzle-orm": { name: "Drizzle ORM", category: "ORM" },
  "@supabase/supabase-js": { name: "Supabase", category: "Backend platform" }, firebase: { name: "Firebase", category: "Backend platform" }, stripe: { name: "Stripe", category: "Payments" },
  "next-auth": { name: "NextAuth.js / Auth.js", category: "Authentication" }, "@clerk/nextjs": { name: "Clerk", category: "Authentication" }, "@auth0/auth0-react": { name: "Auth0", category: "Authentication" },
  "@tanstack/react-query": { name: "TanStack Query", category: "Data fetching" }, redux: { name: "Redux", category: "State management" }, zustand: { name: "Zustand", category: "State management" },
  "@apollo/client": { name: "Apollo Client", category: "GraphQL client" }, graphql: { name: "GraphQL", category: "API style" }, "socket.io": { name: "Socket.IO", category: "Realtime" },
  three: { name: "Three.js", category: "3D graphics" }, d3: { name: "D3", category: "Data visualization" }, "chart.js": { name: "Chart.js", category: "Data visualization" },
  "@xyflow/react": { name: "React Flow", category: "Data visualization" }, reactflow: { name: "React Flow", category: "Data visualization" }, "monaco-editor": { name: "Monaco Editor", category: "Code editor" },
  "@monaco-editor/react": { name: "Monaco Editor", category: "Code editor" }, codemirror: { name: "CodeMirror", category: "Code editor" }, "framer-motion": { name: "Framer Motion", category: "Animation" },
  gsap: { name: "GSAP", category: "Animation" }, "@sentry/browser": { name: "Sentry", category: "Error monitoring" }, "@sentry/nextjs": { name: "Sentry", category: "Error monitoring" }, "posthog-js": { name: "PostHog", category: "Analytics" },
  "@radix-ui/react-dialog": { name: "Radix UI", category: "UI library" }, "@mui/material": { name: "MUI", category: "UI library" }, "@chakra-ui/react": { name: "Chakra UI", category: "UI library" }, antd: { name: "Ant Design", category: "UI library" },
  "@dnd-kit/core": { name: "dnd-kit", category: "Interaction" }, "react-dnd": { name: "react-dnd", category: "Interaction" }, cmdk: { name: "cmdk", category: "Interaction" }, flask: { name: "Flask", category: "Web framework" },
  fastapi: { name: "FastAPI", category: "Web framework" }, django: { name: "Django", category: "Web framework" }, rails: { name: "Ruby on Rails", category: "Web framework" }, "spring-boot-starter-web": { name: "Spring Boot", category: "Web framework" },
};

export async function investigateSource(name: string, inputs: InputFile[], o: { kind?: "files" | "archive" | "repo" | "folder"; origin?: string; structure?: StructureExtractor } = {}): Promise<Investigation> {
  const startedAt = now();
  const tree: SourceTreeAnalysis = await analyzeSourceTree(inputs);
  const evidence: Evidence[] = [];
  const ev = (e: Omit<Evidence, "id" | "timestamp">) => { const id = uid("ev"); evidence.push({ id, timestamp: now(), ...e }); return id; };

  // technologies: manifests + language mix, each with evidence
  const techs: Technology[] = [];
  const seen = new Map<string, Technology>();
  for (const d of tree.dependencies.filter((d) => !d.dev || DEP_TECH[d.name])) {
    const t = DEP_TECH[d.name] ?? DEP_TECH[d.name.toLowerCase()];
    if (!t) continue;
    const id = ev({ kind: "observed", method: "manifest", source: d.source, confidence: 0.95, summary: `${d.name}${d.version ? `@${d.version}` : ""} declared in ${d.source}${d.dev ? " (dev)" : ""}`, related: [`tech:${t.name}`] });
    const cur = seen.get(t.name);
    if (cur) cur.evidence.push(id);
    else { const tech: Technology = { name: t.name, category: t.category, version: d.version?.replace(/^[\^~>=<\s]+/, ""), confidence: 0.95, evidence: [id] }; seen.set(t.name, tech); techs.push(tech); }
  }
  for (const l of tree.languages.slice(0, 6)) {
    if (["JSON", "Markdown", "YAML", "Text", "Lockfile", "TOML", "Unknown", "gitignore", "XML"].includes(l.language)) continue;
    const id = ev({ kind: "observed", method: "file-scan", source: "source tree", confidence: 1, summary: `${l.files} ${l.language} file(s), ${l.lines} lines`, related: [`tech:${l.language}`] });
    techs.push({ name: l.language, category: "Language", confidence: 1, evidence: [id] });
  }
  for (const b of tree.buildSystems) {
    const id = ev({ kind: "observed", method: "file-scan", source: "source tree", confidence: 0.9, summary: `Build/config marker: ${b}` });
    techs.push({ name: b, category: "Build system", confidence: 0.9, evidence: [id] });
  }
  // also run the web fingerprint on HTML/JS in the tree (catches CDN-loaded libs)
  const html = tree.files.filter((f) => f.language === "HTML" && f.content).slice(0, 10);
  const fp = fingerprint({ url: "source://tree", headers: {}, html: html.map((h) => h.content).join("\n"), scriptUrls: [], scripts: [], css: [], cssUrls: [], meta: {}, cookies: [] });
  evidence.push(...fp.evidence);

  // features from source structure
  const features: Feature[] = [];
  const addFeature = (nameF: string, category: string, description: string, files: string[], evIds: string[], purpose: string, deps: string[] = []) =>
    features.push({ id: `ft_${hashStr(nameF + category).slice(0, 10)}`, name: nameF, category, description, pages: [], files: files.slice(0, 40), evidence: evIds, confidence: 0.85, provenance: "observed",
      spec: { purpose, inputs: ["Unknown: derive from the listed files"], outputs: ["Unknown"], states: ["Unknown: runtime states need execution"], transitions: [], dependencies: deps, errorStates: ["Unknown"], accessibility: [], hypotheses: [] } });
  const has = (...n: string[]) => n.some((x) => seen.has(x));
  const grep = (re: RegExp) => tree.files.filter((f) => re.test(f.path)).map((f) => f.path);
  if (tree.routes.length) addFeature("Routing & pages", "Navigation", `${tree.routes.length} file-system route(s)`, tree.routes.map((r) => r.file), [ev({ kind: "observed", method: "file-scan", source: "source tree", confidence: 0.95, summary: `Routes: ${tree.routes.slice(0, 12).map((r) => r.route).join(", ")}` })], "Map URLs to screens.");
  const authFiles = grep(/auth|login|signin|signup|session/i);
  if (authFiles.length || has("NextAuth.js / Auth.js", "Clerk", "Auth0", "Supabase", "Firebase")) addFeature("Authentication", "Accounts", "Sign-in / session handling", authFiles, [ev({ kind: "observed", method: "file-scan", source: authFiles[0] ?? "manifest", confidence: 0.8, summary: `Auth-related files: ${authFiles.slice(0, 5).join(", ") || "auth dependency declared"}` })], "Identify users and manage sessions.", [...seen.keys()].filter((k) => ["NextAuth.js / Auth.js", "Clerk", "Auth0", "Supabase", "Firebase"].includes(k)));
  if (tree.databaseDefinitions.length) addFeature("Data model & persistence", "Data", tree.databaseDefinitions.map((d) => d.detail).join("; ").slice(0, 160), tree.databaseDefinitions.map((d) => d.path), [ev({ kind: "observed", method: "file-scan", source: tree.databaseDefinitions[0]!.path, confidence: 0.95, summary: `Database definitions: ${tree.databaseDefinitions.map((d) => `${d.kind}:${d.path}`).join(", ")}` })], "Persist application data.");
  if (tree.endpoints.length) addFeature("API client calls", "Integration", `${tree.endpoints.length} endpoint reference(s)`, [...new Set(tree.endpoints.map((e) => e.file))], [ev({ kind: "reconstructed", method: "source-scan", source: tree.endpoints[0]!.file, confidence: 0.8, summary: `Endpoints: ${tree.endpoints.slice(0, 10).map((e) => e.url).join(", ")}` })], "Exchange data with a backend.");
  const apiRoutes = grep(/(?:^|\/)(?:api|routes|controllers|handlers)\//i).filter((p) => /\.(?:[jt]sx?|py|go|rs|rb|php|java|kt)$/.test(p));
  if (apiRoutes.length) addFeature("Server-side API", "Backend", `${apiRoutes.length} handler file(s)`, apiRoutes, [ev({ kind: "observed", method: "file-scan", source: apiRoutes[0]!, confidence: 0.8, summary: `API/handler files: ${apiRoutes.slice(0, 6).join(", ")}` })], "Serve data and business logic.");
  if (has("Stripe")) addFeature("Payments", "Commerce", "Stripe SDK dependency", grep(/stripe|checkout|billing|payment/i), [seen.get("Stripe")!.evidence[0]!], "Take payments / manage subscriptions.", ["Stripe"]);
  const viz = ["D3", "Chart.js", "React Flow", "Three.js"].filter((x) => seen.has(x));
  if (viz.length) addFeature(viz.includes("React Flow") ? "Interactive node graph" : "Data visualisation / graphics", "Visualisation", viz.join(", "), grep(/chart|graph|flow|viz|canvas|scene/i), viz.map((v) => seen.get(v)!.evidence[0]!), "Render data or 3D graphically.", viz);
  if (has("Monaco Editor", "CodeMirror")) addFeature("Code editor", "Editors", "Embedded editor component", grep(/editor/i), ["Monaco Editor", "CodeMirror"].filter((x) => seen.has(x)).map((v) => seen.get(v)!.evidence[0]!), "Edit source text.", ["Monaco Editor", "CodeMirror"].filter((x) => seen.has(x)));
  if (has("Socket.IO") || tree.endpoints.some((e) => /^wss?:/.test(e.url))) addFeature("Realtime updates", "Data", "WebSocket / Socket.IO usage", grep(/socket|realtime|ws/i), [ev({ kind: "observed", method: "source-scan", source: "source tree", confidence: 0.8, summary: "WebSocket/Socket.IO usage" })], "Receive pushed updates.");
  if (has("dnd-kit", "react-dnd")) addFeature("Drag and drop", "Interaction", "DnD library dependency", grep(/dnd|drag|sortable/i), ["dnd-kit", "react-dnd"].filter((x) => seen.has(x)).map((v) => seen.get(v)!.evidence[0]!), "Reorder or move items.");
  if (has("cmdk")) addFeature("Command palette", "Interaction", "cmdk dependency", grep(/command|palette/i), [seen.get("cmdk")!.evidence[0]!], "Keyboard-driven commands.");
  if (tree.components.length >= 5) addFeature("Component library", "UI", `${tree.components.length} components`, [...new Set(tree.components.map((c) => c.file))], [ev({ kind: "observed", method: "source-scan", source: tree.components[0]!.file, confidence: 0.85, summary: `Components: ${tree.components.slice(0, 12).map((c) => c.name).join(", ")}` })], "Reusable UI building blocks.");

  // user-supplied technical artifacts (OpenAPI / GraphQL / HAR / SBOM / logs)
  const art = analyzeTechnicalArtifacts(inputs);
  evidence.push(...art.evidence); features.push(...art.features);

  // multi-language structure (symbols + HTTP routes) from a real parser, when the host provides one
  let st: StructureResult | undefined; let stError: string | undefined;
  if (o.structure) { try { st = await o.structure.extract(structureCandidates(tree.files)); } catch (e) { stError = (e as Error).message; } }
  const codeEndpoints = st ? routeEndpoints(st, ev) : [];
  if (st && codeEndpoints.length) {
    const routeFiles = [...new Set(st.files.filter((f) => f.routes.length).map((f) => f.path))];
    addFeature("HTTP API surface (parsed from source)", "Backend", `${codeEndpoints.length} route(s) defined in ${routeFiles.length} file(s)`, routeFiles, codeEndpoints.slice(0, 20).map((e) => e.evidence), "Serve these HTTP routes. Request and response shapes are not captured by static route parsing.");
  }

  // findings
  const findings: Finding[] = [...art.findings];
  const fnd = (area: Finding["area"], severity: Finding["severity"], title: string, detail: string, source: string) => findings.push({ id: uid("fd"), area, severity, title, detail, evidence: [ev({ kind: "observed", method: "file-scan", source, confidence: 1, summary: title })] });
  for (const s of tree.secretFiles) fnd("security", "high", `Secret-shaped value in ${s.path}`, `${s.kinds.join(", ")} pattern. The value is NOT stored; verify and rotate if live.`, s.path);
  if (!tree.files.some((f) => /^(?:LICEN[CS]E|COPYING)/i.test(f.path))) fnd("quality", "info", "No LICENSE file", "Without a licence, others have no right to reuse this code.", "source tree");
  if (tree.manifests.some((m) => m.buildSystem === "npm/node") && !tree.files.some((f) => /(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f.path)) && !inputs.some((f) => /lock/.test(f.path))) fnd("quality", "low", "No lockfile", "Installs are not reproducible without a lockfile.", "package.json");
  if (!tree.files.some((f) => /(?:test|spec)\.|__tests__|(?:^|\/)tests?\//i.test(f.path))) fnd("quality", "info", "No tests found", "No test files matched common naming conventions.", "source tree");
  if (tree.skipped.length) fnd("quality", "info", `${tree.skipped.length} file(s) not analysed`, tree.skipped.slice(0, 8).map((s) => `${s.path}: ${s.reason}`).join("\n"), "source tree");

  const checks: Investigation["coverage"]["checks"] = [
    { id: "files", label: "Files read and classified", status: tree.skipped.length ? "partial" : "done", detail: `${tree.files.length} text file(s), ${tree.binaries.length} binary, ${tree.skipped.length} skipped` },
    { id: "manifests", label: "Manifests and lockfiles parsed", status: tree.manifests.length ? "done" : "partial", detail: `${tree.manifests.length} manifest(s), ${tree.dependencies.length} dependencies` },
    { id: "imports", label: "Import graph built", status: tree.graph.edges.length ? "done" : "partial", detail: `${tree.graph.edges.length} import edge(s)` },
    { id: "secrets", label: "Secret scan (names only)", status: "done", detail: `${tree.secretFiles.length} file(s) flagged` },
    ...(art.found.length ? [{ id: "artifacts", label: "Technical artifacts parsed", status: (art.notes.length ? "partial" : "done") as "done" | "partial", detail: art.found.map((a) => `${a.kind} ${a.path} (${a.detail})`).join("; ").slice(0, 300) }] : []),
    ...(st ? [{ id: "structure", label: "Code structure parsed (tree-sitter)", status: (st.failed.length || (st.parsed === 0 && st.unsupported > 0) ? "partial" : "done") as "done" | "partial", detail: st.parsed ? `${st.parsed} file(s) in ${st.languages.join(", ")} parsed: ${st.files.reduce((n, f) => n + f.symbols.length, 0)} symbols, ${codeEndpoints.length} HTTP route(s)${st.failed.length ? `; ${st.failed.length} file(s) failed to parse` : ""}${st.unsupported ? `; ${st.unsupported} file(s) in unsupported languages not parsed` : ""}` : "No files in a supported language (Python, JavaScript/TypeScript, Go, Java, Rust, C#)" }]
      : stError || (!o.structure && tree.files.some((f) => /\.(?:py|go|java|rs|cs)$/i.test(f.path))) ? [{ id: "structure", label: "Code structure parsed (tree-sitter)", status: "unavailable" as const, detail: stError ?? "The structure parser is not available in this environment (it runs in the hosted service and the desktop app); symbols and routes in Python, Go, Java, Rust and C# were not extracted" }] : []),
    { id: "runtime", label: "Runtime behaviour observed", status: "skipped", detail: "Source was read, not executed. Behaviour specs list unobserved states as Unknown." },
    { id: "server", label: "Server-side logic", status: tree.files.length ? "partial" : "unavailable", detail: tree.files.length ? "Read from source where present in this tree" : "No source provided" },
  ];
  const applicable = checks.filter((c) => c.status !== "unavailable");
  const score = applicable.reduce((n, c) => n + (c.status === "done" ? 1 : c.status === "partial" ? 0.5 : 0), 0) / Math.max(1, applicable.length);

  const files = tree.files.map((f) => ({ ...f, content: f.content }));
  const inv: Investigation = {
    id: uid("inv"), name, targets: [{ id: uid("tg"), kind: o.kind ?? "files", value: o.origin ?? name, addedAt: startedAt }], config: { ...DEFAULT_CRAWL, mode: "single", fetchAssets: false }, status: "done",
    startedAt, finishedAt: now(), progress: 1, pages: [], assets: [], technologies: mergeTechnologies([techs, fp.technologies, art.technologies]), files, dependencies: [...tree.dependencies, ...art.dependencies], endpoints: [...art.endpoints, ...tree.endpoints].map((e) => ("foundIn" in e ? e : { url: e.url, method: e.method, kind: /graphql/i.test(e.url) ? "graphql" as const : /^wss?:/.test(e.url) ? "websocket" as const : "rest" as const, foundIn: e.file, evidence: "" })).filter((e) => !codeEndpoints.some((c) => c.url === e.url && c.foundIn.split(":")[0] === e.foundIn)).concat(codeEndpoints), // the parsed route supersedes the older method-less reference from the same file
    features, findings, evidence, graph: tree.graph, coverage: { score: Math.round(score * 100) / 100, checks },
    limitations: [...art.notes, ...checks.filter((c) => c.status === "skipped" || c.status === "unavailable").map((c) => `${c.label}: ${c.detail}`), ...(tree.binaries.length ? [`${tree.binaries.length} binary file(s) were inventoried but not decompiled; use the desktop app's REA integration for binaries.`] : [])],
    thirdParties: art.thirdParties.length ? art.thirdParties : undefined, questions: tree.envVars.length ? ["Which environment variables are required at runtime? Names found: " + tree.envVars.slice(0, 12).map((e) => e.name).join(", ")] : [],
    log: [{ t: now(), level: "info", msg: `Analysed ${tree.files.length} file(s): ${tree.languages.slice(0, 3).map((l) => `${l.language} ${l.lines}L`).join(", ")}` }],
    components: tree.components.map((c) => ({ name: c.name, source: c.file, provenance: "recovered" as const })),
    routes: [...tree.routes.map((r) => ({ route: r.route, source: r.file, via: "file-system" as const })), ...(st ? st.files.flatMap((f) => f.routes.map((r) => ({ route: r.path, source: `${r.file}:${r.line}`, via: "code" as const }))) : [])], envVars: tree.envVars,
    ...(st ? { symbols: capSymbols(st) } : {}),
  };
  return inv;
}
