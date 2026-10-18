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

## Known gaps / not done
See FEATURES.md rows marked N or P. Blocked by environment: Vercel deploy to the user's account (connector bound to another team); Apple signing (no certificate); live cloud-model and OSV.dev calls (no keys / egress).
