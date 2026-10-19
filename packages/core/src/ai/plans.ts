/**
 * Deterministic plan builders: investigation + intent → AgentTask graph.
 * The graph is data the user can inspect, edit and override before (or while) it runs.
 */
import type { AgentTask, Feature, Investigation } from "../schema.js";
import { task } from "./agents.js";
import { untrusted } from "./untrusted.js";

export interface StackPreset {
  id: string;
  label: string;
  kind: "web" | "desktop" | "mobile" | "backend" | "cli" | "extension" | "static";
  hint: string;
  files: string[]; // files a minimal scaffold must contain
  install?: string;
  build?: string;
  test?: string;
  previewable: boolean;
}

export const STACKS: StackPreset[] = [
  { id: "nextjs", label: "Next.js + Tailwind (TypeScript)", kind: "web", hint: "Next.js App Router, React, Tailwind CSS, TypeScript. Route handlers under app/api for backend.", files: ["package.json", "app/page.tsx", "app/layout.tsx"], install: "npm install", build: "npm run build", test: "npm test", previewable: false },
  { id: "react-vite", label: "React + Vite (TypeScript)", kind: "web", hint: "Vite, React 18+, TypeScript, plain CSS or Tailwind. Client-side only.", files: ["package.json", "index.html", "src/main.tsx", "src/App.tsx"], install: "npm install", build: "npm run build", test: "npm test", previewable: true },
  { id: "vue-vite", label: "Vue + Vite (TypeScript)", kind: "web", hint: "Vite, Vue 3 Composition API, TypeScript.", files: ["package.json", "index.html", "src/main.ts", "src/App.vue"], install: "npm install", build: "npm run build", test: "npm test", previewable: true },
  { id: "svelte", label: "SvelteKit", kind: "web", hint: "SvelteKit with TypeScript.", files: ["package.json", "src/routes/+page.svelte"], install: "npm install", build: "npm run build", test: "npm test", previewable: false },
  { id: "static", label: "Static HTML/CSS/JS", kind: "static", hint: "Plain HTML, CSS and ES modules with no build step.", files: ["index.html"], previewable: true },
  { id: "tauri", label: "Tauri desktop app (React + Rust)", kind: "desktop", hint: "Tauri 2 with a React/Vite front end and Rust commands.", files: ["package.json", "src/App.tsx", "src-tauri/Cargo.toml", "src-tauri/src/main.rs", "src-tauri/tauri.conf.json"], install: "npm install", build: "npm run tauri build", test: "cargo test --manifest-path src-tauri/Cargo.toml", previewable: false },
  { id: "swiftui-macos", label: "Native macOS app (SwiftUI)", kind: "desktop", hint: "SwiftUI macOS app as a Swift package/Xcode project; no third-party UI dependencies.", files: ["Package.swift", "Sources/App/App.swift"], build: "swift build", test: "swift test", previewable: false },
  { id: "electron", label: "Electron app", kind: "desktop", hint: "Electron with a renderer in React or plain HTML.", files: ["package.json", "main.js", "index.html"], install: "npm install", build: "npm run build", test: "npm test", previewable: false },
  { id: "react-native", label: "React Native (Expo)", kind: "mobile", hint: "Expo + React Native + TypeScript.", files: ["package.json", "App.tsx", "app.json"], install: "npm install", test: "npm test", previewable: false },
  { id: "fastapi", label: "Python FastAPI service", kind: "backend", hint: "FastAPI + Pydantic, pytest.", files: ["pyproject.toml", "app/main.py", "tests/test_api.py"], install: "pip install -e .", test: "pytest -q", previewable: false },
  { id: "express", label: "Node.js Express API", kind: "backend", hint: "Express + TypeScript, vitest.", files: ["package.json", "src/server.ts"], install: "npm install", build: "npm run build", test: "npm test", previewable: false },
  { id: "rust-cli", label: "Rust CLI", kind: "cli", hint: "Cargo binary crate with clap.", files: ["Cargo.toml", "src/main.rs"], build: "cargo build", test: "cargo test", previewable: false },
  { id: "python-cli", label: "Python CLI", kind: "cli", hint: "Typer/argparse CLI with pytest.", files: ["pyproject.toml", "src/cli.py"], install: "pip install -e .", test: "pytest -q", previewable: false },
  { id: "chrome-ext", label: "Chrome extension (MV3)", kind: "extension", hint: "Manifest V3 extension with a service worker and popup.", files: ["manifest.json", "popup.html"], previewable: false },
  { id: "astro", label: "Astro (content site)", kind: "web", hint: "Astro with TypeScript; content collections for pages, islands only where interactivity is needed.", files: ["package.json", "astro.config.mjs", "src/pages/index.astro"], install: "npm install", build: "npm run build", previewable: false },
  { id: "nuxt", label: "Nuxt 3 (Vue)", kind: "web", hint: "Nuxt 3, Vue 3, TypeScript; server routes under server/api.", files: ["package.json", "nuxt.config.ts", "app.vue"], install: "npm install", build: "npm run build", test: "npm test", previewable: false },
  { id: "remix", label: "React Router v7 / Remix", kind: "web", hint: "React Router framework mode with loaders/actions, TypeScript.", files: ["package.json", "app/root.tsx", "app/routes.ts"], install: "npm install", build: "npm run build", test: "npm test", previewable: false },
  { id: "angular", label: "Angular", kind: "web", hint: "Angular standalone components, TypeScript, signals.", files: ["package.json", "angular.json", "src/main.ts", "src/app/app.component.ts"], install: "npm install", build: "npm run build", test: "npm test", previewable: false },
  { id: "django", label: "Django (Python)", kind: "backend", hint: "Django with templates or DRF, pytest-django.", files: ["manage.py", "pyproject.toml", "config/settings.py", "config/urls.py"], install: "pip install -e .", test: "pytest -q", previewable: false },
  { id: "flask", label: "Flask (Python)", kind: "backend", hint: "Flask app factory, Jinja templates, pytest.", files: ["pyproject.toml", "app/__init__.py", "tests/test_app.py"], install: "pip install -e .", test: "pytest -q", previewable: false },
  { id: "rails", label: "Ruby on Rails", kind: "web", hint: "Rails with Hotwire, minitest.", files: ["Gemfile", "config/routes.rb", "app/controllers/application_controller.rb"], install: "bundle install", test: "bin/rails test", previewable: false },
  { id: "laravel", label: "Laravel (PHP)", kind: "web", hint: "Laravel with Blade or Inertia, PHPUnit.", files: ["composer.json", "routes/web.php", "app/Http/Controllers/Controller.php"], install: "composer install", test: "php artisan test", previewable: false },
  { id: "go-api", label: "Go HTTP service", kind: "backend", hint: "Go standard library net/http with a small router, table-driven tests.", files: ["go.mod", "main.go"], build: "go build ./...", test: "go test ./...", previewable: false },
  { id: "spring", label: "Spring Boot (Java)", kind: "backend", hint: "Spring Boot with Gradle (Kotlin DSL), JUnit 5.", files: ["build.gradle.kts", "src/main/java/app/Application.java"], build: "gradle build", test: "gradle test", previewable: false },
  { id: "aspnet", label: "ASP.NET Core (C#)", kind: "backend", hint: "ASP.NET Core minimal APIs, xUnit.", files: ["App.csproj", "Program.cs"], build: "dotnet build", test: "dotnet test", previewable: false },
  { id: "flutter", label: "Flutter (Dart)", kind: "mobile", hint: "Flutter with Material 3; widget tests.", files: ["pubspec.yaml", "lib/main.dart"], install: "flutter pub get", test: "flutter test", previewable: false },
  { id: "kotlin-android", label: "Android (Kotlin, Compose)", kind: "mobile", hint: "Jetpack Compose, Gradle Kotlin DSL; JVM unit tests only.", files: ["settings.gradle.kts", "app/build.gradle.kts", "app/src/main/AndroidManifest.xml"], build: "gradle assembleDebug", test: "gradle testDebugUnitTest", previewable: false },
  { id: "swiftui-ios", label: "Native iOS app (SwiftUI)", kind: "mobile", hint: "SwiftUI iOS app as a Swift package; no third-party UI dependencies.", files: ["Package.swift", "Sources/App/App.swift"], build: "swift build", test: "swift test", previewable: false },
  { id: "supabase-web", label: "React + Supabase (auth, Postgres, storage)", kind: "web", hint: "Vite + React front end using Supabase for auth and Postgres; SQL migrations under supabase/migrations with row-level security policies; keys only via env names.", files: ["package.json", "index.html", "src/main.tsx", "supabase/migrations/0001_init.sql"], install: "npm install", build: "npm run build", test: "npm test", previewable: false },
  { id: "go-cli", label: "Go CLI", kind: "cli", hint: "Go with cobra or the flag package, table-driven tests.", files: ["go.mod", "main.go"], build: "go build ./...", test: "go test ./...", previewable: false },
  { id: "node-cli", label: "Node.js CLI", kind: "cli", hint: "TypeScript CLI with a bin entry, vitest.", files: ["package.json", "src/cli.ts"], install: "npm install", build: "npm run build", test: "npm test", previewable: false },
  { id: "vscode-ext", label: "VS Code extension", kind: "extension", hint: "VS Code extension in TypeScript with @vscode/test-electron or vitest for logic.", files: ["package.json", "src/extension.ts"], install: "npm install", build: "npm run compile", previewable: false },
  { id: "firefox-ext", label: "Firefox / cross-browser extension (WebExtensions)", kind: "extension", hint: "WebExtensions manifest v3 compatible with Firefox and Chromium.", files: ["manifest.json", "popup.html"], previewable: false },
  { id: "discord-bot", label: "Discord bot (discord.js)", kind: "backend", hint: "discord.js v14 with slash commands; token from env only.", files: ["package.json", "src/index.ts"], install: "npm install", build: "npm run build", test: "npm test", previewable: false },
  { id: "any", label: "Any stack (describe it)", kind: "web", hint: "Use the stack the user describes in the free-text field.", files: [], previewable: false },
];

export const stackById = (id: string) => STACKS.find((s) => s.id === id) ?? STACKS[0]!;

/* ---------------- briefs (untrusted-fenced) ---------------- */

export function siteBrief(inv: Investigation, max = 22_000): string {
  const lines: string[] = [];
  lines.push(`Target: ${inv.targets.map((t) => t.value).join(", ")} (${inv.pages.length} pages, ${inv.assets.length} assets)`);
  lines.push(`Technologies: ${inv.technologies.filter((t) => t.confidence >= 0.6).map((t) => `${t.name}${t.version ? " " + t.version : ""}`).join(", ") || "none confidently detected"}`);
  lines.push("\nPAGES");
  for (const p of inv.pages.slice(0, 60)) lines.push(`- ${new URL(p.url).pathname} — “${p.title}” h:[${p.headings.slice(0, 4).map((h) => h.text).join(" | ")}] forms:${p.forms.length} links:${p.links.length}`);
  lines.push("\nFEATURES");
  for (const f of inv.features) lines.push(`- ${f.name} [${f.provenance}, ${Math.round(f.confidence * 100)}%]: ${f.description}`);
  if (inv.endpoints.length) { lines.push("\nENDPOINTS"); for (const e of inv.endpoints.slice(0, 40)) lines.push(`- ${e.kind} ${e.method ?? "?"} ${e.url}`); }
  if (inv.designTokens) lines.push(`\nDESIGN TOKENS\ncolors: ${inv.designTokens.colors.slice(0, 10).map((c) => c.value).join(", ")}\nfonts: ${inv.designTokens.fonts.map((f) => f.value).join(", ")}\nvariables: ${Object.entries(inv.designTokens.variables).slice(0, 20).map(([k, v]) => `${k}:${v}`).join("; ")}`);
  const withText = [...inv.pages].filter((p) => p.text).sort((a, b) => a.depth - b.depth).slice(0, 8);
  if (withText.length) {
    lines.push("\nPAGE TEXT (what visitors read, as Markdown; reproduce real copy rather than inventing it)");
    let budget = 7_000;
    for (const p of withText) { if (budget <= 0) break; const t = p.text!.slice(0, Math.min(1_400, budget)); budget -= t.length; lines.push(`--- ${new URL(p.url).pathname}${t.length < p.text!.length ? " (excerpt)" : ""}\n${t}`); }
  }
  if (inv.limitations.length) lines.push("\nKNOWN LIMITS\n" + inv.limitations.map((l) => `- ${l}`).join("\n"));
  return untrusted("site-analysis", lines.join("\n"), max);
}

export function featureBrief(inv: Investigation, f: Feature, max = 30_000): string {
  const ev = inv.evidence.filter((e) => f.evidence.includes(e.id)).slice(0, 12);
  const related = inv.files.filter((file) => f.files.includes(file.path) || new RegExp(f.name.split(/\W+/).filter((w) => w.length > 3).join("|") || "$^", "i").test(file.path)).slice(0, 6);
  const parts = [
    `FEATURE: ${f.name} (${f.category}) — ${f.description}`,
    `PROVENANCE: ${f.provenance}, confidence ${Math.round(f.confidence * 100)}%`,
    `SPEC:\n${JSON.stringify(f.spec, null, 2)}`,
    `EVIDENCE:\n${ev.map((e) => `- [${e.kind}] ${e.summary}${e.snippet ? `\n    ${e.snippet.slice(0, 300)}` : ""}`).join("\n")}`,
    related.length ? `RECOVERED SOURCE (exact originals; check licence before reuse):\n${related.map((r) => `--- ${r.path}\n${(r.content ?? "").slice(0, 6000)}`).join("\n")}` : "RECOVERED SOURCE: none — implement independently from the spec",
  ];
  return untrusted(`feature:${f.id}`, parts.join("\n\n"), max);
}

/* ---------------- rebuild plans ---------------- */

export type RebuildMode = "functional" | "visual" | "architecture" | "modernized" | "enhanced" | "feature-only" | "migration" | "synthesis";

export const REBUILD_MODES: { id: RebuildMode; n: number; label: string; blurb: string }[] = [
  { id: "functional", n: 1, label: "Functional recreation", blurb: "Reimplement the observable behaviour" },
  { id: "visual", n: 2, label: "Visual recreation", blurb: "Prioritise appearance and interactions" },
  { id: "architecture", n: 3, label: "Architecture recreation", blurb: "Recreate the supported architectural patterns" },
  { id: "modernized", n: 4, label: "Modernised version", blurb: "A cleaner, more maintainable implementation" },
  { id: "enhanced", n: 5, label: "Enhanced version", blurb: "Original feature set plus your improvements" },
  { id: "feature-only", n: 6, label: "Feature-only extraction", blurb: "Recreate only the selected features" },
  { id: "migration", n: 7, label: "Application migration", blurb: "Convert an application you own to another stack" },
  { id: "synthesis", n: 8, label: "Comparative synthesis", blurb: "Combine compatible features from several apps" },
];

export interface RebuildOptions {
  inv: Investigation;
  mode: RebuildMode;
  stackId: string;
  stackNote?: string;
  featureIds?: string[]; // feature-only / synthesis
  improvements?: string; // enhanced
  backend?: string; // "different backend"
}

const MODE_GUIDE: Record<RebuildMode, string> = {
  functional: "Reproduce every observed behaviour with the simplest correct implementation. Visual fidelity is secondary.",
  visual: "Match layout, spacing, colour tokens, typography, responsive behaviour and micro-interactions as closely as the evidence allows. Behaviour may be stubbed with local state.",
  architecture: "Recreate the architectural patterns (routing model, data flow, state management, API boundaries) the evidence supports. Name modules after what they do.",
  modernized: "Preserve behaviour but choose modern, maintainable patterns: typed APIs, small components, clear module boundaries, accessibility by default.",
  enhanced: "Implement the full observed feature set, then apply the requested improvements. Keep a changelog of what was added beyond the reference.",
  "feature-only": "Implement ONLY the selected features as self-contained modules with a minimal host app to run them.",
  migration: "Port the supplied application you own to the target stack, preserving behaviour. Map each source module to a target module.",
  synthesis: "Combine the selected features from the analysed applications into one coherent product with a unified design.",
};

export function buildRebuildPlan(o: RebuildOptions): AgentTask[] {
  const stack = stackById(o.stackId);
  const features = (o.featureIds?.length ? o.inv.features.filter((f) => o.featureIds!.includes(f.id)) : o.inv.features).slice(0, 12);
  const brief = siteBrief(o.inv);
  const stackLine = `Target stack: ${stack.label}. ${stack.hint}${o.stackNote ? ` Additional stack notes from the user: ${o.stackNote}` : ""}${o.backend ? ` Backend choice: ${o.backend}.` : ""}`;
  const guide = `Mode: ${o.mode}. ${MODE_GUIDE[o.mode]}\n${stackLine}\nThis is an INDEPENDENT implementation based on observed behaviour; private server-side source is unavailable and must be designed, not copied.`;

  const spec = task({
    role: "architecture", objective: `Write SPEC.md: the implementation specification (pages, navigation, components, state, data schema, API contracts, auth, styling tokens, responsive rules) and ARCHITECTURE.md.\n${guide}${o.improvements ? `\nRequested improvements: ${o.improvements}` : ""}`,
    inputs: [brief], acceptance: ["file_exists:SPEC.md", "file_exists:ARCHITECTURE.md"], tools: ["list_files", "read_file", "write_file", "finish"],
  });
  const scaffold = task({
    role: "development", objective: `Create the project scaffold for ${stack.label}: ${stack.files.length ? `at minimum ${stack.files.join(", ")}` : "the files the stack needs"}, config, README.md with run instructions, .env.example listing environment variable NAMES only, and a LICENSE-free placeholder note. Follow SPEC.md.`,
    dependsOn: [spec.id], inputs: [guide], acceptance: stack.files.map((f) => `file_exists:${f}`).concat(["file_exists:README.md"]),
  });
  const featureTasks = features.map((f) =>
    task({
      role: "development", objective: `Implement the “${f.name}” feature according to SPEC.md and the evidence below. Write complete files and wire it into the app.`,
      dependsOn: [scaffold.id], inputs: [featureBrief(o.inv, f), guide], acceptance: ["writes_files", `Feature “${f.name}” is reachable from the UI`, "No placeholder or TODO stubs"],
    }),
  );
  const ui = task({ role: "uiux", objective: `Apply the design tokens and responsive layout from the analysis; ensure keyboard accessibility, focus states and mobile layout with no horizontal overflow.`, dependsOn: [scaffold.id, ...featureTasks.map((t) => t.id)], inputs: [brief] });
  const tests = task({
    role: "testing", objective: `Write tests that can fail for each implemented feature (and the API contracts), then run them${stack.test ? ` with \`${stack.test}\`` : ""}. Report actual results.`,
    dependsOn: [ui.id], acceptance: stack.test ? [`run:${stack.test}`] : [], inputs: [guide],
  });
  const review = task({ role: "review", objective: "Review the whole project against SPEC.md and the security rules: correctness, secrets, input validation, accessibility. List concrete issues with file paths, or state that none were found.", dependsOn: [tests.id] });
  const fix = task({ role: "development", objective: "Fix every concrete issue raised by the review and any failing tests; re-run the checks. If there were none, confirm and do nothing.", dependsOn: [review.id], acceptance: stack.test ? [`run:${stack.test}`] : [] });
  return [spec, scaffold, ...featureTasks, ui, tests, review, fix];
}

/**
 * The prompt for a CLI coding agent (Claude Code) that rebuilds an analysed app inside an isolated copy of a folder.
 * The analysis itself travels separately as the fenced background brief; this is only the instruction.
 */
export function rebuildInstruction(o: Omit<RebuildOptions, "inv"> & { inv: Investigation }): string {
  const stack = stackById(o.stackId);
  const features = (o.featureIds?.length ? o.inv.features.filter((f) => o.featureIds!.includes(f.id)) : []).slice(0, 12);
  return [
    `Rebuild the application described in the background analysis of “${o.inv.name}” in this folder.`,
    `Mode: ${o.mode}. ${MODE_GUIDE[o.mode]}`,
    `Target stack: ${stack.label}. ${stack.hint}${o.stackNote ? ` ${o.stackNote}` : ""}${o.backend ? ` Backend: ${o.backend}.` : ""}`,
    features.length ? `Implement these features: ${features.map((f) => f.name).join("; ")}.` : "",
    o.improvements && o.mode === "enhanced" ? `Then apply these improvements: ${o.improvements}` : "",
    stack.files.length ? `The project must contain at least: ${stack.files.join(", ")}, plus a README.md with run instructions and an .env.example listing variable NAMES only.` : "",
    stack.test ? `Write tests that can fail and make \`${stack.test}\` pass${stack.build ? `; \`${stack.build}\` must also succeed` : ""} — only if you are allowed to run commands, otherwise say plainly that you could not run them.` : "",
    "This is an INDEPENDENT implementation from observed behaviour: do not copy third-party proprietary code, and never invent private server-side logic as if it were observed. No placeholder or TODO stubs.",
  ].filter(Boolean).join("\n");
}

/* ---------------- single-feature extraction ---------------- */

export interface ExtractOptions {
  inv: Investigation;
  featureId: string;
  destStack: string;
  destFiles?: string[]; // existing project files (paths) for integration context
  request?: "extract" | "improve" | "adapt" | "implement-existing";
  note?: string;
}

export function buildFeatureExtractionPlan(o: ExtractOptions): AgentTask[] {
  const f = o.inv.features.find((x) => x.id === o.featureId);
  if (!f) throw new Error("Feature not found in this investigation");
  const stack = stackById(o.destStack);
  const verb = { extract: "Recreate", improve: "Recreate and improve", adapt: `Adapt to ${stack.label}`, "implement-existing": "Implement the behaviour inside the existing application" }[o.request ?? "extract"];
  const dest = `Destination stack: ${stack.label}. ${stack.hint}\nExisting files:\n${(o.destFiles ?? []).slice(0, 200).join("\n") || "(empty project)"}${o.note ? `\nUser note: ${o.note}` : ""}`;
  const spec = task({ role: "reverse", objective: `Define the functional boundary of “${f.name}”: what it does, its state and data requirements, dependencies, and an implementation specification. Write FEATURE_SPEC.md.`, inputs: [featureBrief(o.inv, f), dest], acceptance: ["file_exists:FEATURE_SPEC.md"] });
  const impl = task({ role: "development", objective: `${verb} the “${f.name}” feature per FEATURE_SPEC.md as a reusable module with a clear props/API surface. Reuse the destination's existing conventions. Independent implementation; do not copy code you were not given.`, dependsOn: [spec.id], inputs: [dest] });
  const integ = task({ role: "development", objective: "Integrate the module into the destination app (routes/imports/state) with minimal edits to existing files.", dependsOn: [impl.id], inputs: [dest] });
  const test = task({ role: "testing", objective: `Write tests that exercise the feature's behaviours from FEATURE_SPEC.md and run them${stack.test ? ` (\`${stack.test}\`)` : ""}.`, dependsOn: [integ.id], acceptance: stack.test ? [`run:${stack.test}`] : [] });
  const review = task({ role: "review", objective: "Verify the feature matches FEATURE_SPEC.md and that the integration did not break existing behaviour.", dependsOn: [test.id] });
  return [spec, impl, integ, test, review];
}

/* ---------------- AI development modes A–H ---------------- */

export type DevMode = "scratch" | "reference" | "improve" | "extract" | "merge" | "convert" | "debug" | "autonomous";
export const DEV_MODES: { id: DevMode; letter: string; label: string; blurb: string; needs: string }[] = [
  { id: "scratch", letter: "A", label: "Build from scratch", blurb: "Describe an app; get a spec and an implementation", needs: "description" },
  { id: "reference", letter: "B", label: "Build from reference", blurb: "Use analysed apps as evidence for an independent build", needs: "investigation" },
  { id: "improve", letter: "C", label: "Improve existing app", blurb: "Analyse, propose, implement and verify improvements", needs: "project" },
  { id: "extract", letter: "D", label: "Extract feature", blurb: "Implement a discovered feature in your project", needs: "investigation+project" },
  { id: "merge", letter: "E", label: "Merge application features", blurb: "Combine features from several applications", needs: "investigations" },
  { id: "convert", letter: "F", label: "Convert framework", blurb: "Migrate source to another framework", needs: "project" },
  { id: "debug", letter: "G", label: "Debug and repair", blurb: "Find errors, write fixes, run tests", needs: "project" },
  { id: "autonomous", letter: "H", label: "Autonomous development", blurb: "Complete an approved spec within resource and deploy limits", needs: "spec" },
];

export function buildDevPlan(mode: DevMode, o: { prompt: string; stackId: string; files?: string[]; inv?: Investigation; targetStackId?: string }): AgentTask[] {
  const stack = stackById(o.stackId);
  const ctx = `User request:\n${o.prompt}\n\nStack: ${stack.label}. ${stack.hint}\nFiles:\n${(o.files ?? []).slice(0, 200).join("\n") || "(none)"}`;
  switch (mode) {
    case "scratch":
    case "autonomous": {
      const spec = task({ role: "architecture", objective: "Turn the request into SPEC.md (goals, users, pages/screens, data model, API, acceptance tests).", inputs: [ctx], acceptance: ["file_exists:SPEC.md"] });
      const scaffold = task({ role: "development", objective: `Scaffold ${stack.label} and implement the spec end to end with complete files, README.md and .env.example (names only).`, dependsOn: [spec.id], acceptance: stack.files.map((f) => `file_exists:${f}`) });
      const ui = task({ role: "uiux", objective: "Polish the interface: hierarchy, responsive layout, accessibility, empty/loading/error states.", dependsOn: [scaffold.id] });
      const tests = task({ role: "testing", objective: `Write and run tests${stack.test ? ` (\`${stack.test}\`)` : ""}.`, dependsOn: [ui.id], acceptance: stack.test ? [`run:${stack.test}`] : [] });
      const review = task({ role: "review", objective: "Independent review against SPEC.md and the security rules.", dependsOn: [tests.id] });
      return [spec, scaffold, ui, tests, review];
    }
    case "reference":
      if (!o.inv) throw new Error("Build-from-reference needs a completed investigation");
      return buildRebuildPlan({ inv: o.inv, mode: "functional", stackId: o.stackId, stackNote: o.prompt });
    case "improve": {
      const audit = task({ role: "reverse", objective: "Analyse the existing codebase: structure, quality, bugs, performance and accessibility issues. Write IMPROVEMENTS.md with prioritised, concrete proposals.", inputs: [ctx], acceptance: ["file_exists:IMPROVEMENTS.md"] });
      const impl = task({ role: "development", objective: "Implement the proposals in IMPROVEMENTS.md that are low-risk and in scope of the user's request. Minimal, reviewable edits.", dependsOn: [audit.id], inputs: [ctx] });
      const tests = task({ role: "testing", objective: "Add regression tests and run the existing test suite.", dependsOn: [impl.id], acceptance: stack.test ? [`run:${stack.test}`] : [] });
      const review = task({ role: "review", objective: "Verify the changes are correct, minimal and do not alter unrelated behaviour.", dependsOn: [tests.id] });
      return [audit, impl, tests, review];
    }
    case "extract":
      if (!o.inv) throw new Error("Select a feature from an investigation");
      return buildFeatureExtractionPlan({ inv: o.inv, featureId: o.inv.features[0]!.id, destStack: o.stackId, destFiles: o.files, note: o.prompt });
    case "merge": {
      const analyze = task({ role: "architecture", objective: "Identify reusable concepts across the supplied applications and design one unified product. Write MERGE_PLAN.md (which feature comes from where, conflicts, unified data model).", inputs: [ctx], acceptance: ["file_exists:MERGE_PLAN.md"] });
      const build = task({ role: "development", objective: "Implement the unified product per MERGE_PLAN.md.", dependsOn: [analyze.id] });
      const tests = task({ role: "testing", objective: "Write and run tests for each merged feature.", dependsOn: [build.id], acceptance: stack.test ? [`run:${stack.test}`] : [] });
      return [analyze, build, tests, task({ role: "review", objective: "Review the merged result.", dependsOn: [tests.id] })];
    }
    case "convert": {
      const target = stackById(o.targetStackId ?? o.stackId);
      const map = task({ role: "architecture", objective: `Map every source module to its equivalent in ${target.label}. Write MIGRATION_MAP.md.`, inputs: [ctx], acceptance: ["file_exists:MIGRATION_MAP.md"] });
      const port = task({ role: "development", objective: `Port the code to ${target.label} per MIGRATION_MAP.md, preserving behaviour.`, dependsOn: [map.id], inputs: [`Target: ${target.label}. ${target.hint}`] });
      const tests = task({ role: "testing", objective: "Port or write tests and run them.", dependsOn: [port.id], acceptance: target.test ? [`run:${target.test}`] : [] });
      return [map, port, tests, task({ role: "review", objective: "Verify behavioural parity with the source.", dependsOn: [tests.id] })];
    }
    case "debug": {
      const diag = task({ role: "reverse", objective: "Reproduce and diagnose the reported problem. Run the build/tests, read the errors, and write DIAGNOSIS.md naming the root cause(s) with file paths.", inputs: [ctx], tools: ["list_files", "read_file", "search_files", "run_command", "write_file", "finish"], acceptance: ["file_exists:DIAGNOSIS.md"] });
      const fix = task({ role: "development", objective: "Write the minimal fixes for the diagnosed causes.", dependsOn: [diag.id] });
      const verify = task({ role: "testing", objective: "Re-run build and tests to prove the problem is fixed; add a regression test.", dependsOn: [fix.id], acceptance: stack.test ? [`run:${stack.test}`] : [] });
      return [diag, fix, verify];
    }
  }
}
