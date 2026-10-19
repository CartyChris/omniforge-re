# OmniForge RE

Universal reverse-engineering and AI development studio. Point it at a website, a GitHub repo, a folder, an archive or an installed app and get an **evidence-linked analysis** (every claim says whether it was observed, recovered, reconstructed or inferred, with a coverage score computed from real checks). Then extract features, re-create the app in another stack, edit it in a built-in workspace with AI, and ship it to GitHub or Vercel.

Two apps, one engine and one project format:

| | Web (Vercel) | macOS (Tauri 2) |
|---|---|---|
| Analyse sites / repos / ZIPs | ✅ (static HTML; SSRF-guarded server functions) | ✅ + real Chromium rendering |
| Local folders, installed apps, REA, AI CLIs, local models, git, terminal | — | ✅ via the local bridge |
| Credentials | encrypted in the browser (AES-GCM) | macOS Keychain |

**More than a crawler:** page copy is kept as Markdown for faithful rebuilds · jQuery/Angular/lodash/… versions and their known vulnerabilities are identified (retire.js rules) · Python/Java/Go/Rust/C#/TS source is parsed with tree-sitter · minified or obfuscated JS can be made readable in a sandbox (desktop) · a pixel + structure compare checks a rebuild against its reference · your installed **Claude Code, Codex CLI, Gemini CLI, OpenCode or Aider** can rebuild or edit a private copy of a folder (with its own sign-in, using your existing subscription), with a per-file diff you approve before anything is written, optionally with pinned **MCP** tools · OmniForge's own agents load **Agent Skills** (`SKILL.md`, from `~/.claude/skills` and friends on the Mac) and call **MCP servers** directly, with tool pinning · **Sign in with OpenRouter** (no key to paste) next to Anthropic, OpenAI, Gemini, xAI, Moonshot and local Ollama/LM Studio/llama.cpp/MLX/vLLM · **Ask AI** retrieves the evidence, page copy and source passages that match your question · on the Mac, **OWASP Noir** (if installed) adds endpoints from 50+ frameworks to folder analysis · secrets are redacted with our rules plus all 221 **gitleaks** rules · and OmniForge itself is an **MCP server** (`omniforge-bridge mcp`, setup on the Integrations page) so Claude Code, Cursor or Claude Desktop can analyse a site and ask for a rebuild brief.

What is and isn't done, section by section: **[FEATURES.md](FEATURES.md)**. Build history and decisions: **[WORKLOG.md](WORKLOG.md)**.

## Run it

```bash
pnpm install
pnpm dev                          # web UI on http://localhost:5173
pnpm --filter @omniforge/server dev   # (optional) local API on :8787 for hosted-style analysis
pnpm test                         # unit tests (core + server)
pnpm e2e                          # Playwright, desktop + mobile, on the production build
```
Node ≥ 22.19, pnpm 10.

## Deploy the web app to **your** Vercel account (chriscarty123@gmail.com)

The repository is a zero-config import: `vercel.json` carries the install/build/output settings (Build Output API: static UI + serverless functions + security headers).

1. Sign in at <https://vercel.com> with chriscarty123@gmail.com. If GitHub isn't connected: *Account → Authentication → Connect GitHub* and grant access to `CartyChris/omniforge-re`.
2. **Add New → Project → Import Git Repository → `CartyChris/omniforge-re`.**
3. Leave **Root Directory** = repository root and **Framework Preset** = *Other*. Do **not** override Install/Build/Output — they come from `vercel.json`. No environment variables are required.
4. Deploy. Every push to `main` redeploys.
5. Verify: open the URL (log out of Vercel or use a private window — if you get a Vercel login page, turn off *Settings → Deployment Protection → Vercel Authentication* for the project). Then `curl https://<your-url>/api/health` should return JSON with `"ok":true`, and analysing `https://example.com` from the Analyze page should finish with a report.

> Not yet verified on Vercel itself: this session's Vercel connector belongs to a different team and was refused (HTTP 403), so the production deploy could not be done or smoke-tested from here. The same build runs locally and under Playwright.

## Install the macOS app

Builds come from **Actions → Desktop (macOS)** (artifacts `omniforge-re-apple-silicon` and `omniforge-re-intel`; tagged releases `vX.Y.Z` attach the DMGs). The app is **unsigned** unless the repository has the Apple secrets below, so macOS will warn on first launch:

- Drag *OmniForge RE* to Applications, then **right-click → Open → Open** (once), or
- `xattr -dr com.apple.quarantine "/Applications/OmniForge RE.app"`

The app starts its engine on a random loopback port with a per-launch token; nothing listens on the network. Logs: `~/Library/Logs/com.omniforge.re/engine.log`. Optional signing/notarisation secrets: `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and for notarisation `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`.

## Safety model (short)

Analysed material is untrusted: it is fenced before reaching a model, secrets are redacted before storage/export, private/loopback/metadata addresses are refused (re-checked at connect time), robots.txt and rate limits are honoured, login/paywall/CAPTCHA are never bypassed, every command/deploy/publish/install needs your approval, local-only mode keeps everything off cloud models, and sensitive actions are written to an audit trail (Settings → Diagnostics).

## Layout

`packages/core` isomorphic engine · `packages/server` portable handlers + loopback bridge · `apps/web` UI · `apps/desktop` Tauri shell · `fixtures` test fixtures (including a **scripted** stand-in model used only for plumbing tests).
