# OmniForge RE — feature traceability

Every section of the original specification, with an honest status. **"Verified" means a check that can fail was run and passed**; the evidence is named. Nothing here is a mock-up: where a capability depends on something this build environment could not provide (a Mac, API keys, your accounts), it says so.

Statuses: **V** Implemented and Verified · **U** Implemented but Unverified · **P** Partially Implemented · **N** Not Implemented · **X** Unsupported (deliberately; see reason).

Evidence key: *unit* = vitest (core 242, server 97) · *e2e* = Playwright on the production build, desktop + mobile, run locally and on GitHub Actions · *real-X* = ran against the real tool, not a stand-in · *mutation* = the guard was disabled and the test confirmed to fail.

| § | Requirement | Status | Evidence / notes |
|---|---|---|---|
| 1 | One product: Vercel web app + native macOS app sharing one project data model | **V** web · **U** macOS bundle | One `@omniforge/core` engine + one UI. Web: e2e. macOS: the real Tauri app was launched under Xvfb on Linux and connected its embedded UI to its engine under the production CSP; the macOS `.app`/`.dmg` is built by CI (see *Hand-off status*). |
| 2 | Architecture | **P** | pnpm monorepo, isomorphic core, portable server handlers, Tauri 2 + Rust shell, Bun-compiled engine sidecar. **Substitutions:** Vite + React 19 + Tailwind 4 + Radix instead of Next.js + shadcn/ui (static SPA + serverless functions fits both Vercel and Tauri with one codebase); IndexedDB + ZIP export/import instead of PostgreSQL; in-process jobs instead of durable queues; no object storage. Postgres/queues/object storage: **N**. |
| 3A | Single URL analysis | **V** | e2e against a fixture site (robots honoured, evidence, exports). |
| 3B | Multiple URLs, batch, **comparison of two sites/apps/versions** | **V** | Batch: e2e. Compare page (stack/features/routes/endpoints/deps/third parties, version drift): unit + e2e. Feature matching is by name and is labelled a hint, not proof of equal behaviour. |
| 3C | GitHub repo URLs, local folders, ZIP/TAR/archives, packages | **V** | Real GitHub tarball + inspect (real-GitHub), bomb-safe archive extraction + path-traversal rejection (unit, mutation), local folders via the bridge (e2e with real engine). |
| 3D | Installed apps (`.app`, Electron `asar`, binaries) | **U** | Via the desktop bridge + REA. Electron sample and REA verified on Linux; macOS `.app` bundles themselves not exercised here. |
| 3E | Technical artifacts: OpenAPI, GraphQL, HAR, SBOM, logs | **V** | unit incl. secret/HAR-body non-retention (mutation). Live OSV vulnerability lookup: **U** (osv.dev unreachable from the build sandbox; verified against a mocked API). |
| 3F | Screenshots / visual inputs to a vision model | **N** | Vision is a routing capability in the model router; there is no image-upload analysis UI. |
| 3G | PDF text extraction | **N** | |
| 4 | Deep website reverse engineering | **V** web-static · **V** desktop-rendered | robots/sitemap/rate limits/redirects, link graph, assets, JS AST (acorn), source-map recovery (only `sourcesContent` is called "recovered"), tech fingerprinting, API/endpoint discovery, design tokens, third parties. Browser rendering with real Chromium incl. inside the compiled engine (real-Chromium); hosted web build is static-HTML only (stated in the report limits). |
| 4 | Authenticated-session analysis (user logs in in a headed browser) | **N** | Deliberately not a bypass: the tool never defeats login/paywall/CAPTCHA. A user-driven headed session is not built. |
| 5 | Reverse Engineer Anything (REA) | **V** (Linux) · **U** (macOS) | Real REA CLI invoked through the bridge; tool detection and typed results. |
| 6 | Other open-source tools | **P** | Used: Playwright, acorn, cheerio, OSV.dev API (instead of osv-scanner). Detected on the machine and reported, **not driven**: Ghidra, jadx, Hopper, semgrep, ast-grep, osv-scanner, repomix, rizin. **Not integrated:** Crawlee, Firecrawl, tree-sitter. Licences respected (all permissive/dev-time). |
| 7 | Analysis reporting | **V** | Markdown, HTML (escaped, sandboxed preview), JSON, graph JSON, Mermaid, full ZIP bundle, PDF via browser print; e2e downloads the ZIP and inspects it. |
| 8 | Feature extraction engine / Feature Library | **V** | Spec cards with provenance + evidence, save, compare 2, recreate, export, add to project (e2e + unit). |
| 9 | Full rebuild modes 1–8 | **V** plumbing · quality not benchmarked | Plans with machine-checkable acceptance (`file_exists:`, `file_contains:`, `run:`), executed by the agent harness. Verified with a *scripted* stand-in model (labelled as such) and real Claude Code CLI chat; code quality from a real cloud model was not benchmarked. |
| 10 | Provider system | **V** adapters (mock servers) · **U** live cloud | Anthropic, OpenAI, Gemini, xAI, Moonshot, OpenRouter, Ollama, LM Studio, llama.cpp, MLX, Unsloth, vLLM, custom OpenAI-compatible; model discovery, capability inference, routing by task/privacy/cost. No API keys were available, so live cloud calls are unverified. |
| 11 | AI CLI integration | **V** Claude Code (chat) · **U** Codex/Gemini/OpenCode/Aider | Real `claude` CLI answered through the bridge. Other CLIs: adapters + detection, not installed here. **CLI-direct agentic mode (CLI edits the folder itself): N** — CLIs are used as text providers. |
| 12 | macOS bridge | **V** (loopback/auth) · **U** (macOS-only parts) | Loopback-only bind, per-launch UI token, pairing code, origin allow-list, 401 for unauthenticated calls, fs sandbox by approved roots, command approvals (unit + e2e + real engine). Keychain, native menus and `lipo`/`codesign` checks are macOS-only (CI). |
| 13 | Local AI models | **P** | Detection of Ollama/LM Studio/llama.cpp/MLX/vLLM/Unsloth, model listing, routing, install hints. **N:** model pull/management, Unsloth training/export workflows. |
| 14 | AI development harness | **P** | Role agents, task graph with dependencies, tool use with path sandbox, approvals, usage metering, acceptance checks, prompt-injection fencing (**V**). **N:** persistent agent memory, MCP client, embeddings retrieval. |
| 15 | Dev modes A–H | **V** plumbing | Plans built and run with the scripted model; not benchmarked with real models. |
| 16 | Built-in dev environment | **V** | Monaco (local workers, no CDN), file tree, tabs, problems, sandboxed static/React preview, terminal + test runner + git (desktop), checkpoints with diff, **AI edit panel (⌘/Ctrl+I) with diff → accept/reject/undo**. All e2e. |
| 17 | Reconstruction workflow (steps 1–21) | **P** | Steps 1–17, 20–21 implemented. Steps 18–19 (automatic comparison against the reference and repair loop): acceptance checks and test runs exist; **no automated visual/behavioural diff against the reference site**. |
| 18 | UI/UX | **V** | 11 sections, command palette, onboarding, light/dark, keyboard, responsive; axe (WCAG A/AA, contrast audited manually) and no-overflow checks on every route, desktop + mobile. |
| 19 | Security & privacy | **V** | SSRF guard with connect-time DNS check (mutation), prompt-injection fencing, secret redaction before storage/export (mutation), local-only mode, encrypted credential vault / macOS Keychain, approval gate, **audit trail** (e2e), CSP + security headers, git commit excludes secret files (mutation). Dependency vulnerability check: see 3E. |
| 20 | Persistence | **P** | IndexedDB autosave, snapshots, backup/restore ZIP, project export/import (e2e). No server DB (see §2). |
| 21 | GitHub & deployment | **V** GitHub flows (fake API) · **U** live | Create repo, commit tree, **branch + pull request** (base never written), approval before every publish — unit + e2e against a stateful fake GitHub; read access verified against real GitHub. Vercel deploy via API verified against a mock server; the app's own Vercel project: **blocked, see below**. GitHub Releases UI: **N** (the macOS workflow attaches builds to tag releases). |
| 22 | Execution strategy | **V** | Stage map, failable checks per stage, mutation checks, CI. |
| 23 | Quality requirements | **V** | No placeholder pages; every route renders real data; errors are surfaced, not swallowed. |
| 24 | Completeness is evidence-based | **V** | Six evidence kinds; coverage computed from real checks (done/partial/skipped/unavailable), limits stated per investigation; never claims private backend logic. |
| 25 | Final deliverables | see below | |

## Hand-off status (§25)

1. **Vercel production app** — built and verified locally (Build Output API, 6 functions, headers) and importable with zero config from `vercel.json`. **Not deployed:** the Vercel connector in this session belongs to a different team and returned 403; deploying to your account needs you (see README → *Deploy to your Vercel account*).
2. **macOS app** — built by `.github/workflows/desktop.yml` on GitHub macOS runners (arm64 + Intel). Unsigned unless you add Apple secrets.
3–12. Bridge, engine, reports, graphs, workflows, workspace, GitHub/Vercel integrations, exports, docs, tests — implemented; see rows above for verification level.
