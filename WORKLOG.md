# Work log

Decisions, what was tried, what failed. Newest last. See FEATURES.md for the status of each spec section.

## Foundations
- pnpm monorepo; `core` is isomorphic (no Node-only APIs) so the same engine runs in the browser, in Vercel functions and in the desktop sidecar. Chose Vite SPA over Next.js: one static UI serves both Vercel and Tauri.
- Evidence model first (observed/recovered/dynamic/reconstructed/inferred/unavailable); coverage is computed from named checks, never from a model's confidence.
- SSRF guard with a connect-time DNS check, robots/rate limits, bomb-safe archive extraction; prompt-injection fencing (`untrusted()`); approvals gate for every command/deploy/publish/install.

## Upgrade pass after the model downgrade
- Audited `sourcemap.ts`, `archive.ts`, `deps.ts`, `source.ts`; fixed secret retention (values were stored in `Investigation.files`/exports) → `redactForStorage`, HAR bodies never stored; mutation-checked.
- Bridge root-id collision (sibling folders shared a base64 prefix) → sha256 id. `git commit all` would have committed `.env` → secret files excluded, with test.
- `debounce.flush()` did not run the pending call (data-loss window) → fixed. Report HTML italics bug (underscores in ids) → code-span lifting + regression test.

## Product surface
- All eleven sections are real pages. Repo Rip (clone / re-create / mesh any GitHub repos, with a rights checkpoint). Technical-artifact ingestion (OpenAPI/GraphQL/HAR/SBOM/logs) and an OSV.dev check.
- Desktop: Tauri 2, Bun-compiled engine sidecar for macOS arm64/x64, Keychain, native menus. Real Tauri release build run under Xvfb: needed `--features custom-protocol` (otherwise the window loads the dev URL).
- Vercel: Build Output API build (`apps/web/scripts/build-api.mjs`), 6 esbuild-bundled functions, CSP/security headers.

## This session's closing pass
- Audit trail (persistent, secrets scrubbed, writes serialised) + Diagnostics view.
- Workspace AI edit: whole-file proposals only; rejected when the reply is cut off, has no code block, is a no-op, or abbreviates ("// … rest unchanged"); warnings for big shrinkage / new secret-like values; Accept/Reject/Undo + audit. **A test bug found by mutation:** `toMatchObject({ reason: /re/ })` silently passes in vitest (regexes aren't matched) — rewritten with `expect.stringMatching`; all other suites were grep-checked for the same pattern.
- Monaco `DiffEditorWidget` dispose error when closing a diff (found by the new e2e) → detach models first.
- GitHub branch + pull request flow (base never written; refuses branch==base, bad names, missing base) with approval; stateful fake-GitHub e2e.
- Compare two investigations; Setup & diagnostics (real probes, downloadable report); dashboard recent activity.
- CI: e2e failures are now emitted as GitHub annotations so they are readable without log access. Findings: `tsx` missing in a clean install; Chromium logging the sandboxed report iframe refusing a harness-injected script (filtered, sandbox attribute still asserted); macOS bundle failed only at signing because empty `APPLE_*` secrets still define env vars → exported only when set.

## Result of the closing CI runs
- GitHub Actions on `022d77b`: unit + typecheck + cargo check + **44 e2e passed**. macOS workflow on `7646af1`: both architectures built (Rust compiled on macOS for the first time — the `cfg(macOS)` Keychain code compiled without changes), bundle verification and the arm64 launch smoke test passed.

## Integration research and first integrations
- Five parallel research passes (web capture/deobfuscation, code & binary analysis, MCP, agents/skills/memory/RAG, generation/verification/deploy/compliance) → `docs/integration-research.md` + `docs/research/`. Everything is labelled tested / checked / read-only; nothing was run on macOS or Vercel.
- The report's sharpest finding was about our own code, not new tools: the licence detector misclassified source-available texts as permissive, and the preview used a non-commercial runtime (Nodebox). Both fixed first, each with a red-then-green test on real licence texts and a mutation check.
- Compare engine: `packages/core/src/verify` (structure diff, severity, repair brief fenced as untrusted) + `packages/server/src/verify.ts` (pixelmatch/pngjs, region clustering) + `/bridge/verify` + Workspace **Verify** panel. Found while testing: Playwright `clip` is limited to the viewport unless `fullPage` is set (tall pages were silently cropped); identical pages still reported "console errors" because the fixture site logs its own — now only errors the reference does not also produce are blamed on the rebuild.
- Test-suite lesson repeated: `toMatchObject({ x: /re/ })` passes vacuously in vitest; use `expect.stringMatching`.

- Deobfuscation (roadmap #3): core owns the stage (which scripts, reconstructed-file labelling, redaction, path safety, endpoint re-scan, coverage check) behind an injected `Deobfuscator`; the server implements it with webcrack + QuickJS single-file WASM, loaded lazily. Mistakes caught on the way: my "the fixture hides `fetchUsers`" assertion was wrong (identifiers survive; only string literals are hidden); the first CI run of the supply-chain step failed because my second bundle marker ("Sustainable Use License") also matches the licence detector's own regex in the shipped bundle — the runtime URL is the precise marker. `caniuse-lite` (CC-BY-4.0 data, via babel/browserslist) entered the dependency set with webcrack and is allowed with an attribution duty.

- Multi-language structure (roadmap #4): new `@omniforge/structure` package with one set of per-language walkers and two loaders (Node/Bun files, browser URLs). Repo/archive analysis runs in a browser worker, so a server-only parser would have missed the main path. Walkers read tree-sitter nodes directly rather than S-expression queries. First real run: 10/12 fixtures passed; the failures were genuine (Rust chained `.route()` came out in reverse with the wrong handler per verb; the older source scan reported the same route a second time without a method) and were fixed in code.
- Testing under the production CSP exposed a pre-existing deployment bug: `index.html` had an inline theme script that the shipped CSP blocks (light-theme users would see a dark flash). Moved to `/theme-init.js`; every route test now runs under the production CSP (shared policy in `apps/web/scripts/csp.mjs`).

- CLI-direct agent mode (roadmap #5): recorded a real Claude Code stream-json transcript first and wrote the normaliser against it (the research had only read the docs). The first probe I ran inherited this session's `CLAUDE_*` environment, so the child CLI reported *this* session's id — the product runner uses the allow-listed `sanitizedEnv`, so that cannot happen there. Verified live that `--setting-sources user --tools … --strict-mcp-config` stops a project `PreToolUse` hook from running (canary file never created). A `rm -rf *` I typed in a probe was (rightly) blocked by the harness's safety check; the probe was redone with `mktemp` and no deletion.

- “Rebuild with Claude Code”: `rebuildInstruction` (core, mutation-checked: improvements only apply in enhanced mode, test command only when the stack has one) + query-param prefill in the Agent CLI tab, seeded once when the project hydrates. The analysis still travels as the fenced background brief, never inlined in the instruction.

- Scaffold catalogue (roadmap #11): stack presets 15 → 34 (Astro, Nuxt, Remix, Angular, Django, Flask, Rails, Laravel, Go, Spring, ASP.NET, Flutter, Android, iOS, Supabase, Go/Node CLI, VS Code/Firefox extensions, Discord bot). A table test checks every preset (unique ids, safe relative file paths, no shell metacharacters in test commands, valid plan graph, scaffold acceptance equals the preset's files); a mutation with a hostile test command failed it. Whether a model produces *good* code for each stack is not measured.

## Known gaps / not done
See FEATURES.md rows marked N or P. Blocked by environment: Vercel deploy to the user's account (connector bound to another team); Apple signing (no certificate); live cloud-model and OSV.dev calls (no keys / egress).
