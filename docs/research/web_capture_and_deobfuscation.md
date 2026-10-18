# Web capture, analysis, cloning and front-end code recovery: integration candidates for OmniForge RE

Research date: 2026-10-18. Method: npm registry metadata (registry.npmjs.org), raw LICENSE files (raw.githubusercontent.com), GitHub repo pages (read via WebFetch, so star counts are rounded as GitHub displays them and WebFetch summaries are secondary), and **first-hand local tests** on Node v22.22.0 and Bun 1.4.2 in a scratch directory. Local-test sources are cited as `file://` links to the scripts or binaries under `/tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/` (session-local, may not persist; the reproduction recipe is given in the text). "Stale" = no npm release in the last ~18 months (i.e. before about April 2025), measured against 2026-10-18.

Abbreviations used below: SCR = `file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad` (local test directory root).

---

## 1. Which JS deobfuscation / bundle-unpacking / unminify tools are maintained and usable as a library (Node/ESM, no native deps), and what are their licence and size?

### Takeaway
**webcrack (MIT, active) is the only maintained deobfuscator/unpacker usable as an in-process JS library, and it becomes serverless-safe and Bun-compile-safe if you replace its default native `isolated-vm` sandbox with a WASM QuickJS sandbox (tested).** It fails to detect bundles from the newest webpack (5.112) in my test, where the new Rust-based **wakaru** CLI (Apache-2.0, very active) succeeds, so the two are complementary; wakaru is sidecar-binary only. Prettier (pure JS) is the right "make it readable" formatter.

### Cited Findings

**webcrack**
- npm `webcrack` 2.16.0, published 2026-04-25 (registry "modified" 2026-06-05), MIT, ESM+CJS exports, 530 KB unpacked, 10 runtime deps (`@babel/*`, `@codemod/matchers`, `debug`, `commander`, `isolated-vm`), engines `>=22.0.0 <23 || >=24.0.0 <25`, 53 versions since 2023-01 — [npm registry: webcrack](https://registry.npmjs.org/webcrack)
- GitHub j4k0xb/webcrack: ~3.0k stars, 341 forks, MIT, 593 commits; description "Deobfuscate obfuscator.io, unminify and unpack bundled javascript" — [GitHub](https://github.com/j4k0xb/webcrack); MIT confirmed in [LICENSE](https://raw.githubusercontent.com/j4k0xb/webcrack/HEAD/LICENSE)
- README scope: deobfuscate obfuscator.io, unminify, transpile, unpack webpack/browserify; "Requirements: Node.js 22 or 24"; notes it depends on `isolated-vm` — [README](https://raw.githubusercontent.com/j4k0xb/webcrack/HEAD/README.md)
- `isolated-vm` is only loaded lazily by the default Node sandbox (`await import("isolated-vm")` in `createNodeSandbox`), and the browser build's default sandbox throws "Custom Sandbox implementation required." This means a custom `sandbox` option replaces it — [webcrack dist/index.js (installed copy)](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/node_modules/webcrack/dist/index.js)
- `isolated-vm` 6.2.0 (the version webcrack pulled in) is a 21 MB native package; its tarball ships prebuilds only for `darwin-arm64`, `linux-arm64`, `linux-x64` (glibc+musl) and `win32-x64` (ABI 127 = Node 22, ABI 137 = Node 24). There is **no `darwin-x64` prebuild**, which matters because OmniForge builds an Intel macOS app — [installed prebuilds listing](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/node_modules/isolated-vm/prebuilds). isolated-vm latest 7.0.1 declares engines `node >=24.0.0`, licence ISC, install = `node-gyp-build || node-gyp rebuild` — [npm registry: isolated-vm](https://registry.npmjs.org/isolated-vm)
- Test input: an obfuscator.io-style sample (control-flow flattening threshold 1 + base64 string array, 3,924 bytes) generated with `javascript-obfuscator`. On Node 22.22 with the prebuilt isolated-vm, webcrack returned fully readable code (original names `fetchUsers`, `Cart`, decoded `"/api/v2/users?limit=50"`) in **78 ms** — [test script t_wc_time.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_wc_time.mjs), [sample generator sample.js](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/sample.js)
- Under **Bun 1.4.2**, webcrack's default sandbox fails: "No native build was found for platform=linux arch=x64 runtime=node abi=147 ... node=26.3.0" (isolated-vm is a V8 binding; Bun runs JavaScriptCore). Webcrack transforms that need no sandbox still work in a Bun-compiled binary (`var a=1+2;console.log("x"+a)` became `var a = 3; console.log("x" + a);`) — [Bun test t_bun.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_bun.mjs), [compiled probe t_compile.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_compile.mjs)
- **Fix verified:** passing `{ sandbox }` built on `quickjs-emscripten` (MIT, 0.32.0, published 2026-02-16, WASM) decoded the same obfuscator.io sample on Node (127 ms) and Bun (137 ms) — [qjs_sandbox.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/qjs_sandbox.mjs), [t_qjs.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_qjs.mjs); [npm: quickjs-emscripten](https://registry.npmjs.org/quickjs-emscripten)
- In a `bun build --compile` binary the default QuickJS `wasmfile` variant fails at runtime ("ENOENT ... /$bunfs/root/emscripten-module.wasm"), but the **single-file variant** `@jitl/quickjs-singlefile-mjs-release-sync` 0.32.0 (MIT, WASM inlined in JS) works: the compiled binary decoded the sample. Sizes: Bun hello-world baseline 81,315,296 bytes; webcrack+QuickJS singlefile 85,489,120 bytes (+4.2 MB); webcrack+prettier+pixelmatch+looks-same+pngjs 89,814,496 bytes (+8.5 MB) — [qjs_single.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/qjs_single.mjs), [t_compile3.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_compile3.mjs); [npm: @jitl/quickjs-singlefile-mjs-release-sync](https://registry.npmjs.org/@jitl%2fquickjs-singlefile-mjs-release-sync)
- Sandbox containment test (QuickJS, 64 MB memory limit, 10 s interrupt): `while(true){}` was interrupted (10.0 s), a memory bomb ended in "out of memory" (14.0 s), and `typeof process/require/fetch` were all `undefined`. Worst-case cost per sandbox call is therefore 10–14 s — [t_qjs_safety.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_qjs_safety.mjs)
- **Limit found:** on a bundle built with the *newest* webpack 5.112.0 (production, minified; modules emitted as `{333(e,r,t){...}}` with `t.d(r,["S",0,e=>...])` exports) webcrack reported **no bundle detected**; on a bundle from webpack 5.97.1 it detected `webpack, modules=3`. Single small test, but it shows webcrack's webpack matcher can lag new webpack output formats — [unpack.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/wp/unpack.mjs), [unpack_old.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/wpold/unpack_old.mjs)

**wakaru**
- GitHub pionxzh/wakaru: ~1.0k stars, 67 forks, **Apache-2.0**, 2,614 commits. README: JavaScript decompiler that splits production bundles into modules and restores modern syntax; supports webpack, esbuild/Bun, Browserify, Metro bundles and Babel/TypeScript/SWC output; CLI-first (`npx wakaru input.js -o output.js`, `--unpack`), standalone binaries via GitHub Releases; CI workflow is `rust-ci.yml`; no library API documented — [GitHub](https://github.com/pionxzh/wakaru), [README](https://raw.githubusercontent.com/pionxzh/wakaru/HEAD/README.md), [LICENSE](https://raw.githubusercontent.com/pionxzh/wakaru/HEAD/LICENSE)
- npm `wakaru` / `@wakaru/cli` **1.14.0 published 2026-10-10** (8 and 26 versions), Apache-2.0; native binaries delivered as optionalDependencies `@wakaru/cli-linux-x64`, `-win32-x64`, `-linux-arm64`, `-win32-arm64`, `-darwin-arm64` (**no darwin-x64 listed**); the linux-x64 package is 26.8 MB unpacked — [npm: @wakaru/cli](https://registry.npmjs.org/@wakaru%2fcli), [npm: wakaru](https://registry.npmjs.org/wakaru), [npm: @wakaru/cli-linux-x64](https://registry.npmjs.org/@wakaru%2fcli-linux-x64)
- Local run of the linux-x64 binary on the webpack 5.112 bundle: `--unpack` produced `entry.js` + `module-91/254/333.js` in ~21 ms wall time with restored ES imports, template literals and arrow functions (e.g. `import { X } from "./module-91.js"`); on the minified sample it restored `const e = await fetch(...)`; on the obfuscator.io sample it left `_0x4905(...)` untouched (it is not a deobfuscator). Subcommands include `extract` (original files from a source map's `sourcesContent`) and `bun` ("Inspect and extract Bun single-file executable containers") — [wakaru binary](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/node_modules/@wakaru/cli-linux-x64/wakaru), [bundle fixture](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/wp/dist/main.js)
- The older TypeScript library packages `@wakaru/unminify` 0.2.2 and `@wakaru/unpacker` 0.1.2 were last published **2024-07-06 (~27 months, stale)**, are 15.7 MB / 17 MB unpacked, and are declared MIT on npm while the repo LICENSE is Apache-2.0 (licence metadata conflict) — [npm: @wakaru/unminify](https://registry.npmjs.org/@wakaru%2funminify), [npm: @wakaru/unpacker](https://registry.npmjs.org/@wakaru%2funpacker). In Node 22 ESM they did not load (unminify: "Cannot find module .../prettier/parser-babel"; unpacker: "Dynamic require of "assert" is not supported"); under Bun both loaded and unminify produced readable code — [t_others.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_others.mjs), [t_bun.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_bun.mjs)

**restringer / flast**
- npm `restringer` 2.3.0 published 2026-08-30, MIT, 486 KB, deps `commander`, `flast`, `js-md5`, `obfuscation-detector`; `flast` 3.2.0 (MIT, 2026-08-30) — [npm: restringer](https://registry.npmjs.org/restringer), [npm: flast](https://registry.npmjs.org/flast)
- README: Node 22+; default sandbox is "Node itself running in a spawned process"; `isolated-vm` optional; Deno/Bun sandbox backends; `--sb-timeout` default 1000 ms; "40+ modules split into safe and unsafe passes" — [README](https://raw.githubusercontent.com/ctrl-escp/restringer/HEAD/README.md). Upstream is HumanSecurity/restringer (MIT, Copyright 2025 HUMAN Security) — [LICENSE](https://raw.githubusercontent.com/HumanSecurity/restringer/HEAD/LICENSE); the repo npm points to (ctrl-escp/restringer) showed 24 stars — [GitHub](https://github.com/ctrl-escp/restringer)
- Same obfuscator.io sample: restringer took **16.7 s**, printed verbose iteration logs to stdout, and left the string-decoder function (`_0x4905`) in the output, versus webcrack's 78 ms full result. One sample only, anecdotal — [t_others.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_others.mjs)

**humanify (LLM identifier renaming)**
- jehna/humanify: ~3.3k stars, 207 forks, MIT, 422 commits. v3 is "a single Rust binary"; the LLM only suggests names, **oxc** performs the AST rename; providers OpenAI (default gpt-5-mini), Gemini, Anthropic, Ollama, OpenRouter, Requesty; not dependent on webcrack (pipe through it first); one LLM call per identifier, README estimates roughly $0.10–$1.00 per medium file — [GitHub](https://github.com/jehna/humanify), [LICENSE](https://raw.githubusercontent.com/jehna/humanify/HEAD/LICENSE)
- npm `humanifyjs` 2.2.2 published 2024-12-16 (stale ~22 months), deps include `node-llama-cpp`, `openai`, `@google/generative-ai`, `webcrack` — [npm: humanifyjs](https://registry.npmjs.org/humanifyjs). The npm name `humanify` is an unrelated 2020 package — [npm: humanify](https://registry.npmjs.org/humanify)

**Formatters (for readability after recovery)**
- `prettier` 3.9.10 (MIT, published 2026-10-10, pure JS, ~10 MB unpacked): formatted the minified sample in 86 ms on Node and works under Bun — [npm: prettier](https://registry.npmjs.org/prettier), [t_others.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_others.mjs), [t_bun.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_bun.mjs)
- `js-beautify` 2.0.3 (MIT, 2026-06-30, ~1 MB) works on Node — [npm: js-beautify](https://registry.npmjs.org/js-beautify); `terser` 5.51.2 (BSD-2-Clause, 2026-08-27) — [npm: terser](https://registry.npmjs.org/terser)
- `@biomejs/biome` 2.5.15 (MIT OR Apache-2.0, 2026-09-30) ships native per-platform binaries as optionalDependencies; `@biomejs/wasm-nodejs` 2.5.15 is **47.3 MB** unpacked, `@biomejs/js-api` 6.0.0 — [npm: @biomejs/biome](https://registry.npmjs.org/@biomejs%2fbiome), [npm: @biomejs/wasm-nodejs](https://registry.npmjs.org/@biomejs%2fwasm-nodejs)

**Abandoned alternatives (all stale)**
- `debundle` 0.5.4 (ISC, 2017), `webpack-unpack` 2.0.0 (Apache-2.0, 2018), `unminify` 2.0.0 (shapesecurity, Apache-2.0, 2022), `javascript-deobfuscator` 1.0.3 (MIT, 2021, "WIP") — [debundle](https://registry.npmjs.org/debundle), [webpack-unpack](https://registry.npmjs.org/webpack-unpack), [unminify](https://registry.npmjs.org/unminify), [javascript-deobfuscator](https://registry.npmjs.org/javascript-deobfuscator)

**Source-map recovery tools (overlap)**
- OmniForge's own `sourcemap.ts` already extracts `sourcesContent` and states the module tree is "recorded as structure only — never presented as recovered code" — [sourcemap.ts](file:///home/user/omniforge-re/packages/core/src/analyze/sourcemap.ts)
- `denandz/sourcemapper` (Go, BSD-3-Clause, ~1.5k stars, 40 commits) extracts source trees from maps/URLs and warns it will request any URL referenced as a sourcemap — [GitHub](https://github.com/denandz/sourcemapper), [LICENSE](https://raw.githubusercontent.com/denandz/sourcemapper/HEAD/LICENSE). `rarecoil/unwebpack-sourcemap` (Python, MIT, ~545 stars) is **archived since 2022-04-16** — [GitHub](https://github.com/rarecoil/unwebpack-sourcemap), [LICENSE](https://raw.githubusercontent.com/rarecoil/unwebpack-sourcemap/HEAD/LICENSE)
- `@jridgewell/trace-mapping` 0.3.31 (MIT, pure JS, published 2025-09-10) is the maintained position-mapping library — [npm](https://registry.npmjs.org/@jridgewell%2ftrace-mapping)

### Inferences
- Recommended deobfuscation stack: **webcrack with an injected QuickJS-WASM sandbox + prettier** as a `packages/core` module; this gives obfuscator.io string-array/control-flow decoding without any native dependency, works on Node 22/24 serverless and in the Bun sidecar, and keeps attacker-controlled decoder code inside a memory- and time-limited interpreter instead of running it in-process.
- Even with a custom sandbox, `isolated-vm` is still a declared dependency of webcrack and will install (21 MB, prebuilt only); whether it can be excluded from a Vercel function bundle or a pnpm install without breaking webcrack was not tested.
- Add wakaru only as an optional desktop sidecar (spawn the binary): it is the better bundle splitter on current webpack output and cleans transpiler helpers, but it ships no `darwin-x64` build on npm (GitHub Releases not checked), is CLI-only, and cannot run on Vercel. Its `bun` subcommand (extract Bun single-file executables) is directly relevant to OmniForge's "installed apps" analysis because OmniForge itself ships a Bun-compiled engine.
- humanify should be treated as a **concept to reimplement** (deterministic rename via AST, LLM only proposes names) using OmniForge's existing provider router, not as a dependency; its v3 is a Rust binary and the npm library is stale.
- Restringer is a niche fallback for non-obfuscator.io patterns; it was far slower and less complete on the one sample tested.
- Do not add sourcemapper/unwebpack-sourcemap: they duplicate `sourcemap.ts`, and sourcemapper's arbitrary-URL fetching would need OmniForge's SSRF guard anyway.

### Gaps
- Webcrack's bundle unpacking was tested on one synthetic webpack bundle only (3 modules); Browserify, Parcel, Vite/Rollup and esbuild bundles were not tested.
- Obfuscators other than obfuscator.io (JScrambler, JSFuck, jjencode, Hikvision-style packers) were not tested with any tool.
- Wakaru's `darwin-x64` availability on GitHub Releases and the licence mismatch for the old `@wakaru/*` npm packages (MIT on npm vs Apache-2.0 in repo) were not resolved.
- Last-commit dates for GitHub repos could not be retrieved (see section 9); npm publish dates are used as the recency signal.
- Whether `isolated-vm` can be skipped in the Vercel build was not tested.

---

## 2. Is a permissively licensed fingerprint database (frameworks, CMS, CDNs, analytics, hosting) available to replace or extend OmniForge's own rules?

### Takeaway
**No permissively licensed, Wappalyzer-sized database exists.** The big one (~7.6k technologies, Wappalyzer JSON) is GPL-3.0 lineage; the permissive one (Nuclei templates, MIT) is active-probing YAML rather than a passive rule set. The best permissive, actionable addition is **retire.js** (Apache-2.0) for JS-library/version detection with vulnerability data.

### Cited Findings
- OmniForge today: `fingerprint.ts` holds 162 `R(name, category, signals, ...)` rules (top categories JavaScript framework 11, Analytics 11, Web framework 10, Hosting 8, Browser API 8), each with signals of kind header/html/scriptUrl/script/meta/cookie/css/cssUrl/url/global, per-signal confidence combined as 1 − Π(1 − c), version capture groups and `implies` — [fingerprint.ts](file:///home/user/omniforge-re/packages/core/src/analyze/fingerprint.ts)
- Original Wappalyzer went private in August 2023; `enthec/webappanalyzer` is the community continuation using the same JSON structure, **GPL-3.0** — [README](https://raw.githubusercontent.com/enthec/webappanalyzer/HEAD/README.md), [LICENSE](https://raw.githubusercontent.com/enthec/webappanalyzer/HEAD/LICENSE). `HTTPArchive/wappalyzer` is also **GPL-3.0** — [LICENSE](https://raw.githubusercontent.com/HTTPArchive/wappalyzer/HEAD/LICENSE)
- npm `wappalyzer` and `wappalyzer-core` are **deprecated** at 7.0.3 (2023-08-23): "This package is no longer being maintained. Please use the API at wappalyzer.com/api" — [npm: wappalyzer](https://registry.npmjs.org/wappalyzer), [npm: wappalyzer-core](https://registry.npmjs.org/wappalyzer-core)
- `projectdiscovery/wappalyzergo`: Go library, code licence **MIT** (Copyright 2021 ProjectDiscovery), ~1.1k stars, 447 commits; its README says it uses data from enthec/webappanalyzer and HTTPArchive/wappalyzer (both GPL-3.0) — [GitHub](https://github.com/projectdiscovery/wappalyzergo), [LICENSE.md](https://raw.githubusercontent.com/projectdiscovery/wappalyzergo/HEAD/LICENSE.md). Its `fingerprints_data.json` is 3,790,366 bytes with **7,646 apps** under a top-level `apps` key; observed entry fields `cats`, `dom`, `meta`, `implies`, `description`, `website`, `icon`, with regexes carrying `\;version:\1` suffixes — [fingerprints_data.json](https://raw.githubusercontent.com/projectdiscovery/wappalyzergo/HEAD/fingerprints_data.json)
- `simple-wappalyzer` 1.1.108 (MIT, published 2026-10-17) wraps the deprecated `wappalyzer-core`, depends on `happy-dom`, and has a `postinstall` script (what it downloads was not checked) — [npm: simple-wappalyzer](https://registry.npmjs.org/simple-wappalyzer)
- `projectdiscovery/nuclei-templates`: **MIT** (Copyright 2025 ProjectDiscovery) — [LICENSE.md](https://raw.githubusercontent.com/projectdiscovery/nuclei-templates/HEAD/LICENSE.md). Technology templates are per-product YAML with matchers; the sampled `wordpress-detect.yaml` issues up to 4 requests (`{{BaseURL}}`, `/wp-admin/install.php`, `/feed/`, `/?feed=rss2`) — [wordpress-detect.yaml](https://raw.githubusercontent.com/projectdiscovery/nuclei-templates/HEAD/http/technologies/wordpress-detect.yaml). The repo-wide stats file lists tag `tech` on 1,215 templates and `detect` on 1,068 — [TEMPLATES-STATS.json](https://raw.githubusercontent.com/projectdiscovery/nuclei-templates/HEAD/TEMPLATES-STATS.json)
- `urbanadventurer/WhatWeb` is **GPL-2.0** — [LICENSE](https://raw.githubusercontent.com/urbanadventurer/WhatWeb/HEAD/LICENSE). `EdgeSecurityTeam/EHole` is Apache-2.0 (its data was not inspected) — [LICENSE](https://raw.githubusercontent.com/EdgeSecurityTeam/EHole/HEAD/LICENSE). For `rverton/webanalyzer`, `tunetheweb/wappalyzer` and `AliasIO/wappalyzer`, **no LICENSE file was found** at the default branch via raw.githubusercontent.com — [rverton/webanalyzer check](https://raw.githubusercontent.com/rverton/webanalyzer/HEAD/LICENSE)
- **retire.js**: Apache-2.0, ~4.2k stars, 1,218 commits; npm `retire` 6.1.0 published 2026-10-06, pure JS (deps `zod`, `walkdir`, `commander`, `astronomical`), engines `^20.19.0 || >=22.12.0`, exports `scanFileContent`, `scanFileName`, `scanUri`, `check`, `isVulnerable` — [GitHub](https://github.com/RetireJS/retire.js), [LICENSE.md](https://raw.githubusercontent.com/RetireJS/retire.js/HEAD/LICENSE.md), [npm: retire](https://registry.npmjs.org/retire), [import test t_others.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_others.mjs). Its `repository/jsrepository-v5.json` is 604,358 bytes with 76 library entries; extractors per library: `func`, `filename`, `filecontent`, `hashes`, plus vulnerability records — [jsrepository-v5.json](https://raw.githubusercontent.com/RetireJS/retire.js/HEAD/repository/jsrepository-v5.json)

### Inferences
- Bundling the GPL-3.0 Wappalyzer-derived JSON into a permissively distributed OmniForge would raise a copyleft question regardless of the MIT wrapper (wappalyzergo's data is GPL-lineage). Safest pattern: keep OmniForge's own rules as the shipped default, and offer an **optional "import Wappalyzer-format rules" feature where the user supplies/downloads the file at runtime** (not redistributed in the app). Legal review is advisable; this is not legal advice.
- OmniForge's rule schema (header/html/script/meta/cookie signals with version capture and `implies`) is structurally close to Wappalyzer JSON, so an importer is feasible; the signal kinds `dom`/`js`/`xhr` in Wappalyzer have no direct equivalent (`global` is closest) and would need mapping.
- Nuclei templates are mainly active-probe checks (extra requests to paths like `/wp-admin/install.php`); only the first-request matchers are passive-compatible, and active probing would conflict with OmniForge's rate-limit/robots posture unless gated.
- retire.js adds something OmniForge does not have: library **identification by file content/hash/URI with version extraction**, feeding the SBOM → OSV pipeline; the data file is small enough to vendor (Apache-2.0 requires attribution/NOTICE).

### Gaps
- How many distinct technologies the Nuclei `http/technologies` directory holds could not be determined (the GitHub listing was truncated at 79 visible files; the stats file did not expose a per-directory count).
- Whether `simple-wappalyzer`'s postinstall downloads GPL data, and from where, was not checked.
- The licence of the data in EHole's `finger.json` and the status of `rverton/webanalyzer` (no LICENSE found) are unresolved.
- Retire's scanning API was only import-tested, not run on real JS files; its Bun behaviour was not tested.
- Last-commit recency for enthec/webappanalyzer could not be retrieved (the commits page returned no history to the fetcher).

---

## 3. What is the best option for pixel/visual diff of rendered screenshots in Node without native deps (rebuilt app vs reference)?

### Takeaway
**pixelmatch (ISC, v8.0.0 published 2026-10-06, zero deps, pure JS) with pngjs for PNG I/O is the best primary choice; looks-same (MIT, pure JS + WASM PNG) is a good optional add-on for diff clusters/bounding boxes.** Both ran on Node 22 and Bun, including inside a compiled Bun binary. odiff is faster but native (desktop-sidecar only).

### Cited Findings
- `pixelmatch` 8.0.0 published 2026-10-06, ISC, ESM, ~37 KB; ~7.0k stars; README: "a few hundred lines of code, has no dependencies, works on raw typed arrays", anti-aliased pixel detection (`includeAA` to disable), perceptual colour difference (OKLab/HyAB per the fetched summary), `threshold` default 0.1 per pixel, optional `windowSize` and `ignoreMask`; **all images must share identical dimensions**; CLI is PNG-only with exit codes 0/66/65/64 — [npm: pixelmatch](https://registry.npmjs.org/pixelmatch), [GitHub](https://github.com/mapbox/pixelmatch), [README](https://raw.githubusercontent.com/mapbox/pixelmatch/HEAD/README.md), [LICENSE](https://raw.githubusercontent.com/mapbox/pixelmatch/HEAD/LICENSE)
- Local test: two 200×100 PNGs differing by a 60×20 red rectangle → pixelmatch returned exactly 1,200 differing pixels in 32 ms and wrote a diff PNG — [t_others.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_others.mjs)
- `pngjs` 7.0.0 (MIT, zero deps, pure JS) was last published **2023-02-20 (stale by the 18-month rule, but a finished pure-JS codec)** — [npm: pngjs](https://registry.npmjs.org/pngjs)
- `looks-same` 10.0.1 (MIT, published 2025-08-18, ~828 stars, Node >=18; deps include `@jsquash/png` 3.1.1 Apache-2.0 WASM published 2025-05-20): ΔE tolerance (default 2.3), `ignoreAntialiasing` and `ignoreCaret` on by default, `shouldCluster` diff clusters, `createDiffImage`. Test result on the same pair: `equal:false`, `diffBounds {left:21, top:20, right:79, bottom:39}`, 1 cluster (correctly bounds the rectangle) — [npm: looks-same](https://registry.npmjs.org/looks-same), [GitHub](https://github.com/gemini-testing/looks-same), [t_others.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_others.mjs), [npm: @jsquash/png](https://registry.npmjs.org/@jsquash%2fpng)
- Bun: `pixelmatch` and `looks-same` import and run under Bun 1.4.2; a `bun build --compile` binary containing webcrack+prettier+pixelmatch+looks-same+pngjs executed correctly — [t_bun.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_bun.mjs), [t_compile.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_compile.mjs)
- `odiff-bin` 4.5.0 (MIT, published 2026-07-23, ~3.3k stars): Zig with SIMD, PNG/JPEG/WebP/TIFF, per-platform native binaries via optionalDependencies (`@odiff/darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-riscv64`, `linux-x64`, `win32-arm64`, ...), Node API with a persistent `ODiffServer` process. Local run (linux-x64): "Found 1200 different pixels (6.00%)", 0.103 s wall including process start — [npm: odiff-bin](https://registry.npmjs.org/odiff-bin), [GitHub](https://github.com/dmtrKovalenko/odiff), [LICENSE](https://raw.githubusercontent.com/dmtrKovalenko/odiff/HEAD/LICENSE.txt)
- Other options: `ssim.js` 3.5.0 (MIT, pure JS, zero deps, last published 2020-10-12, stale) gives an SSIM similarity score — [npm: ssim.js](https://registry.npmjs.org/ssim.js); `jimp` 1.6.1 (MIT, pure JS, 3.3 MB, 27 deps, 2026-04-07) provides crop/resize/diff — [npm: jimp](https://registry.npmjs.org/jimp)
- Unsuitable: `resemblejs` 5.0.0 depends on native `canvas` (2023-06) — [npm: resemblejs](https://registry.npmjs.org/resemblejs); `blink-diff` 1.0.13 (2016) and `upng-js` 2.1.0 (2017) are abandoned — [blink-diff](https://registry.npmjs.org/blink-diff), [upng-js](https://registry.npmjs.org/upng-js); `sharp` 0.35.5 (Apache-2.0) uses native libvips prebuilds — [npm: sharp](https://registry.npmjs.org/sharp); `wasm-vips` 0.0.19 (MIT) is WASM but 13 MB and pre-1.0 — [npm: wasm-vips](https://registry.npmjs.org/wasm-vips)
- OmniForge currently has no automated visual diff: FEATURES.md lists reconstruction steps 18–19 (automatic comparison against the reference and repair loop) as partial with "no automated visual/behavioural diff against the reference site" — [FEATURES.md](file:///home/user/omniforge-re/FEATURES.md)

### Inferences
- A thin `visualDiff(refPng, candidatePng)` in `packages/core` can wrap pixelmatch (pass/fail %, diff PNG), pad/crop to equal size first (pixelmatch rejects size mismatches; handling that is OmniForge's job), and optionally add looks-same clusters to produce "region X differs" evidence, which fits OmniForge's evidence model and could drive the repair loop.
- Capturing the screenshots still needs a browser: Playwright on desktop; in the hosted Vercel mode the diff library works on uploaded images but capture needs serverless Chromium (section 7).
- JPEG screenshots need a decoder (`jpeg-js` or jimp); pixelmatch itself only needs RGBA buffers. Not tested.

### Gaps
- Performance at realistic full-page sizes (e.g. 1440×8000) was not benchmarked; only a 200×100 case was run.
- Playwright's own screenshot comparator internals could not be confirmed from the fetched source file, so no claim is made about it.
- The "accuracy of perceptual metrics against human judgement" for web layouts was not evaluated; SSIM was not tested.

---

## 4. What are the real capabilities and limits of self-hosted Firecrawl and Crawlee versus OmniForge's own crawler: improvement or duplication?

### Takeaway
**Mostly duplication, with policy and licensing downsides.** Firecrawl's server is AGPL-3.0 and needs Redis + RabbitMQ + Postgres + a Playwright service, so it fits neither Vercel nor the Bun sidecar. Crawlee (Apache-2.0) ran fine under Node and Bun but, by default, ignored `robots.txt` and fetched `127.0.0.1`: it would bypass the guarantees OmniForge's crawler already provides.

### Cited Findings

**Firecrawl**
- firecrawl/firecrawl: ~192.7k stars, 10.2k forks, 6,578 commits; server licence **AGPL-3.0** (the LICENSE file is the GNU Affero GPL v3); the README says SDKs and some UI components are MIT — [GitHub](https://github.com/firecrawl/firecrawl), [LICENSE](https://raw.githubusercontent.com/firecrawl/firecrawl/HEAD/LICENSE)
- SDK: `@mendable/firecrawl-js` 4.46.0, MIT, published 2026-10-08, ESM, Node >=22, 1.16 MB unpacked, deps `zod`, `axios`, `firecrawl`, `zod-to-json-schema`, `typescript-event-target` — [npm](https://registry.npmjs.org/@mendable%2ffirecrawl-js)
- SELF_HOST.md (as summarised by the fetch tool): Docker Compose stack of API + workers, a Playwright service, Redis, RabbitMQ and NuQ PostgreSQL (FoundationDB opt-in); default scraping via bundled Playwright with basic fetch fallback; "Fire-engine" is an optional separately configured engine; AI features optional via OpenAI/compatible/Ollama; auth is **off by default** ("The default API is unauthenticated"); the compose file defines no persistent volumes and is "a source-aligned starting point, not a production architecture"; no resource figures given — [SELF_HOST.md](https://raw.githubusercontent.com/firecrawl/firecrawl/HEAD/SELF_HOST.md)

**Crawlee**
- apify/crawlee: ~26.2k stars, 1.7k forks, **Apache-2.0**, 5,789 commits; npm `crawlee` / `@crawlee/*` 3.18.2 published 2026-09-29. README features: HTTP crawling (Cheerio, JSDOM, raw) and browser crawling (Playwright, Puppeteer), persistent BFS/DFS URL queue, proxy rotation and session management, zero-config "human-like" browser fingerprints and TLS-fingerprint replication for HTTP crawling. README states Node 22.13+, while npm engines say `>=16` (conflict) — [GitHub](https://github.com/apify/crawlee), [LICENSE](https://raw.githubusercontent.com/apify/crawlee/HEAD/LICENSE.md), [npm: crawlee](https://registry.npmjs.org/crawlee), [npm: @crawlee/cheerio](https://registry.npmjs.org/@crawlee%2fcheerio)
- Local test, `@crawlee/cheerio` 3.18.2 (135 packages, 40 MB installed): a CheerioCrawler against a local server whose `robots.txt` disallows `/private` crawled `/`, `/a` **and `/private/secret`** with default options, on both Node 22.22 (310 ms) and Bun 1.4.2 (244 ms; run via `bun run`, not compiled). The target was `127.0.0.1`, so no private-address guard stopped it — [run.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial2/run.mjs), [server.mjs](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial2/server.mjs)
- A `respectRobotsTxtFile: boolean | {...}` option exists in the typings of `@crawlee/http` and `enqueueLinks` (off by default in my run) — [http-crawler.d.ts](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial2/node_modules/@crawlee/http/internals/http-crawler.d.ts)

**OmniForge's current crawler**
- Already has a robots/rate-limit-respecting crawler with SSRF guard (connect-time DNS check, mutation-tested), sitemap, link graph; FEATURES.md explicitly lists "Not integrated: Crawlee, Firecrawl, tree-sitter" and states the hosted build is static-HTML-only while desktop renders with real Chromium via Playwright — [FEATURES.md](file:///home/user/omniforge-re/FEATURES.md), [robots.ts](file:///home/user/omniforge-re/packages/core/src/crawl/robots.ts)

**Cheaper ways to get Firecrawl's headline output (LLM-ready markdown)**
- `turndown` 7.2.4 (MIT, 2026-04-03), `@mozilla/readability` 0.6.0 (Apache-2.0, 2025-03-03, ~19 months so stale by the rule), `defuddle` 0.19.5 (MIT, 2026-10-10), `linkedom` 0.18.13 (ISC, 2026-07-07), `happy-dom` 21.0.3 (MIT, 2026-10-15), `jsdom` 30.1.3 (MIT, 2026-10-15) — [turndown](https://registry.npmjs.org/turndown), [readability](https://registry.npmjs.org/@mozilla%2freadability), [defuddle](https://registry.npmjs.org/defuddle), [linkedom](https://registry.npmjs.org/linkedom), [happy-dom](https://registry.npmjs.org/happy-dom), [jsdom](https://registry.npmjs.org/jsdom)

### Inferences
- **Crawlee: do not adopt.** OmniForge already has queueing, politeness and an SSRF guard; Crawlee would need robots enabled and its network layer wrapped in the SSRF check to match, and its fingerprint/TLS-spoofing and proxy-rotation headline features conflict with OmniForge's stated stance of never defeating login/paywall/CAPTCHA protections (FEATURES.md §4). The only gap it would fill (autoscaled concurrency, persistent queue for very large crawls) is not a current OmniForge requirement.
- **Firecrawl: do not embed.** AGPL-3.0 server code cannot be linked into OmniForge without copyleft consequences, and the service needs four backing services. A small optional "remote scraper provider" adapter using the MIT SDK (user supplies their own Firecrawl URL/key) is the only low-risk integration, with limited value.
- The real value Firecrawl markets — clean markdown from rendered pages — can be built in-house from the already-owned Playwright render + `turndown` + readability/defuddle, all pure JS and serverless-safe.

### Gaps
- Firecrawl's actual self-host feature gap versus its cloud (the README comparison is an image) and its resource needs were not verified; SELF_HOST.md was read through a summarising fetch, not line-by-line.
- Crawlee compiled-binary (`bun build --compile`) compatibility and `PlaywrightCrawler` behaviour were not tested.
- Whether Crawlee's `respectRobotsTxtFile` works correctly when enabled was not tested.

---

## 5. Which tools suit offline page archiving (single-file snapshot) for evidence preservation?

### Takeaway
**Avoid SingleFile (AGPL-3.0). For a single-file HTML snapshot on desktop use Monolith (CC0-1.0, Rust binary, no JS engine) fed with Playwright's rendered DOM; for forensic-grade preservation write WARC with `warcio` (permissive: Apache-2.0 per npm, MIT-style LICENSE text; pure JS) plus Playwright's HAR/trace.** HTTrack is GPL native software.

### Cited Findings
- **SingleFile**: licence **AGPL-3.0** (README also invites contact for commercial licensing), ~22.6k stars, 8,418 commits; `single-file-cli` 2.18.5 and `single-file-core` 1.6.35 are both **AGPL-3.0-or-later**, published 2026-10-18; the CLI requires **Node >=24.0.0** — [GitHub](https://github.com/gildas-lormeau/SingleFile), [LICENSE](https://raw.githubusercontent.com/gildas-lormeau/SingleFile/HEAD/LICENSE), [npm: single-file-cli](https://registry.npmjs.org/single-file-cli), [npm: single-file-core](https://registry.npmjs.org/single-file-core)
- **Monolith** (Y2Z/monolith): **CC0-1.0**, ~15.5k stars, 730 commits; CLI+library that bundles a page into one HTML file with CSS/images/JS as data URLs; "doesn't feature a JavaScript engine" (suggests piping headless-Chromium DOM into it); prebuilt binaries plus Cargo/Homebrew/Docker etc.; the page shows Cargo/crates.io, consistent with Rust (language not stated explicitly) — [GitHub](https://github.com/Y2Z/monolith), [LICENSE](https://raw.githubusercontent.com/Y2Z/monolith/HEAD/LICENSE)
- **warcio.js** (Webrecorder): `warcio` 2.4.12, Apache-2.0-licensed on npm, published 2026-09-04, ESM, Node >=18, deps include `pako`, `hash-wasm`, `uuid-random`; repo LICENSE is MIT-style text from Webrecorder — [npm: warcio](https://registry.npmjs.org/warcio), [LICENSE](https://raw.githubusercontent.com/webrecorder/warcio.js/HEAD/LICENSE) (npm field and LICENSE text differ in how they name the licence; both permissive)
- Webrecorder's capture/replay products are **AGPL-3.0**: `browsertrix-crawler`, `replayweb.page`, `wabac.js` — [browsertrix LICENSE](https://raw.githubusercontent.com/webrecorder/browsertrix-crawler/HEAD/LICENSE), [replayweb.page LICENSE](https://raw.githubusercontent.com/webrecorder/replayweb.page/HEAD/LICENSE), [wabac.js LICENSE.md](https://raw.githubusercontent.com/webrecorder/wabac.js/HEAD/LICENSE.md)
- **HTTrack** is **GPL-3.0** native C — [COPYING](https://raw.githubusercontent.com/xroche/httrack/HEAD/COPYING)
- `website-scraper` 6.0.0 (MIT, published 2025-10-30, ESM, Node >=20.18.1; deps cheerio, got, p-queue, fs-extra, css-url-parser, srcset): downloads a site to a local directory including css/images/js — [npm](https://registry.npmjs.org/website-scraper)
- `rrweb-snapshot` 2.1.7 (MIT, published 2026-10-02; dep `postcss`) is an in-page DOM serializer — [npm: rrweb-snapshot](https://registry.npmjs.org/rrweb-snapshot)
- Playwright (Apache-2.0, 1.64.1 published 2026-10-14) documents built-in context-level HAR recording (`recordHar`, content policy omit/embed/attach), a Tracing API whose traces open in Trace Viewer, `page.pdf`, and a `Coverage` class ("gathers information about parts of JavaScript and CSS that were used by the page", Chromium-only, since v1.11) — [npm: playwright-core](https://registry.npmjs.org/playwright-core), [class-coverage.md](https://raw.githubusercontent.com/microsoft/playwright/HEAD/docs/src/api/class-coverage.md), [class-tracing.md](https://raw.githubusercontent.com/microsoft/playwright/HEAD/docs/src/api/class-tracing.md), [browser context options](https://raw.githubusercontent.com/microsoft/playwright/HEAD/docs/src/api/params.md)
- OmniForge currently exports Markdown/HTML/JSON/ZIP/Mermaid/PDF-via-print and a full ZIP bundle via `fflate`; it has no page-snapshot or WARC output — [FEATURES.md](file:///home/user/omniforge-re/FEATURES.md), [core package.json](file:///home/user/omniforge-re/packages/core/package.json)

### Inferences
- Evidence tiers that fit OmniForge's architecture: (1) hosted/static: raw HTML + fetched assets zipped (already close to current ZIP) and optionally a WARC written with `warcio`; (2) desktop: Playwright `recordHar` + trace + screenshot, then Monolith (spawned sidecar) for a single self-contained HTML copy of the *rendered* DOM.
- SingleFile's CLI is a separate process, but AGPL plus a Node >=24 requirement (OmniForge targets >=22) makes it a poor fit; Monolith gives the same deliverable under CC0.
- WARC is the standard for evidence preservation and playback tools exist, but the best replay tools are AGPL; OmniForge would write WARC and leave replay to external viewers.
- Chromium's built-in MHTML snapshot (CDP `Page.captureSnapshot`) is a zero-dependency desktop alternative, but I did not verify it in this research.

### Gaps
- Monolith's last release date and whether macOS Intel and Apple Silicon binaries are published could not be retrieved; it was not run here.
- `warcio` was not run; WARC from Playwright traffic would need OmniForge-side glue (record request/response events) that was not prototyped.
- CDP `Page.captureSnapshot` (MHTML) claims are from memory and unverified.
- `website-scraper` and `rrweb-snapshot` were not tested.

---

## 6. Which candidates are unsuitable (AGPL/GPL/non-commercial, abandoned, native-only) and why?

### Takeaway
No non-commercial or source-available licences turned up among the candidates; the blockers are **AGPL/GPL/LGPL copyleft**, **abandonment**, and **native-only distribution**. The notable trap: the npm package `deobfuscator` (the "synchrony" fork) is GPL-3.0 and the npm name `synchrony` is an unrelated package.

### Cited Findings
- **AGPL-3.0:** Firecrawl server ([LICENSE](https://raw.githubusercontent.com/firecrawl/firecrawl/HEAD/LICENSE)); SingleFile and `single-file-cli`/`single-file-core` ([npm](https://registry.npmjs.org/single-file-cli)); Webrecorder browsertrix-crawler, replayweb.page, wabac.js (links in section 5).
- **GPL:** `relative/synchrony` GPL-3.0 ([LICENSE.md](https://raw.githubusercontent.com/relative/synchrony/HEAD/LICENSE.md)); the matching npm package `deobfuscator` 2.4.6 is GPL-3.0-only, published 2026-07-07, repository `relative/synchrony` ([npm: deobfuscator](https://registry.npmjs.org/deobfuscator)); the npm package literally named `synchrony` is an unrelated 2016 "App data layer" ([npm: synchrony](https://registry.npmjs.org/synchrony)); enthec/webappanalyzer and HTTPArchive/wappalyzer GPL-3.0 (section 2); HTTrack GPL-3.0 (section 5); WhatWeb GPL-2.0 (section 2).
- **LGPL-3.0:** `pa11y` 10.0.0 (published 2026-08-28, modified 2026-10-09), LGPL-3.0-only, depends on `puppeteer`, `axe-core`, `@pa11y/html_codesniffer` — [npm: pa11y](https://registry.npmjs.org/pa11y), [LICENSE](https://raw.githubusercontent.com/pa11y/pa11y/HEAD/LICENSE)
- **MPL-2.0 (file-level copyleft, usable unmodified):** `axe-core` 4.14.0 and `@axe-core/playwright` 4.14.0 — [axe-core LICENSE](https://raw.githubusercontent.com/dequelabs/axe-core/HEAD/LICENSE), [npm: @axe-core/playwright](https://registry.npmjs.org/@axe-core%2fplaywright)
- **Stale or abandoned (last npm release):** `@wakaru/unminify` and `@wakaru/unpacker` 2024-07; `humanifyjs` 2024-12; `debundle` 2017; `webpack-unpack` 2018; `unminify` 2022; `javascript-deobfuscator` 2021; `blink-diff` 2016; `upng-js` 2017; `ssim.js` 2020; `pngjs` 2023-02; `wappalyzer`/`wappalyzer-core` deprecated 2023-08; `playwright-lighthouse` 4.0.0 2024-01-15; `v8-to-istanbul` 9.3.0 2024-06-22; `bundle-buddy` 2019; `source-map-explorer` 2022; `unwebpack-sourcemap` archived 2022-04-16 — registry links in sections 1–3 plus [playwright-lighthouse](https://registry.npmjs.org/playwright-lighthouse), [v8-to-istanbul](https://registry.npmjs.org/v8-to-istanbul), [bundle-buddy](https://registry.npmjs.org/bundle-buddy), [source-map-explorer](https://registry.npmjs.org/source-map-explorer)
- **Native or sidecar-only:** `isolated-vm` (V8 addon; fails to load in Bun; no darwin-x64 prebuild in 6.2.0), wakaru's Rust CLI (no darwin-x64 on npm), `odiff-bin`, Monolith, Biome native, `oxc-parser` (per-platform NAPI bindings, [npm](https://registry.npmjs.org/oxc-parser)), `sharp`, `resemblejs` (`canvas`), `esbuild` (install script + native binaries, [npm](https://registry.npmjs.org/esbuild)), humanify v3 (Rust binary).
- **Not compile-friendly:** Lighthouse bundled by `bun build --compile` (105 MB) crashed at startup with "ENOENT: no such file or directory, scandir '/$bunfs/root/locales/'" — [lh_bin test](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_lh.mjs)
- No GitHub licence file was found for `Design2Code` (SALT-NLP), `rverton/webanalyzer`, `tunetheweb/wappalyzer`, `AliasIO/wappalyzer`, `wappalyzer/wappalyzer` at the default branch via raw.githubusercontent.com — treat as unlicensed until proven otherwise — [Design2Code check](https://raw.githubusercontent.com/SALT-NLP/Design2Code/HEAD/LICENSE)

### Inferences
- Copyleft risk is per integration mode: spawning an *unmodified* AGPL/GPL program as a separate process is a different legal question from linking it; for a product intending to ship permissively, the simpler policy is to exclude them from the default build and offer user-installed detection ("found on your PATH") exactly as OmniForge already does for Ghidra/jadx/etc.
- `pa11y` adds nothing over `axe-core` + `@axe-core/playwright` (pa11y wraps axe and HTML_CodeSniffer in puppeteer) and is LGPL.

### Gaps
- No exhaustive licence audit of transitive dependencies was done (e.g. webcrack's `@babel/*`, Lighthouse's 28 deps).
- Whether any bundled data in Nuclei templates or retire.js carries additional third-party notices was not checked.

---

## 7. Capture, audit and design-to-code tools: Lighthouse, axe-core, web-vitals, serverless Chromium, coverage, screenshot-to-code

### Takeaway
**On desktop, Playwright already provides screenshots, HAR, tracing and CDP coverage; add axe-core (MPL-2.0) and web-vitals (Apache-2.0) as in-page libraries, and run Lighthouse (Apache-2.0) as an optional separate Node process, since it cannot be Bun-compiled.** Hosted screenshots would need `@sparticuz/chromium` (MIT), whose Vercel suitability I could not verify. screenshot-to-code (MIT, Python) is best treated as prompt inspiration.

### Cited Findings
- **Lighthouse**: Apache-2.0, ~30.9k stars; npm 13.5.0 published 2026-09-18 (modified 2026-10-17), ESM, engines node `>=22.19`, 28 deps, 19.2 MB unpacked (22 MB installed); README: "requires Node 22 (LTS) or later" and "use Lighthouse programmatically with the Node module" — [npm](https://registry.npmjs.org/lighthouse), [GitHub](https://github.com/GoogleChrome/lighthouse), [LICENSE](https://raw.githubusercontent.com/GoogleChrome/lighthouse/HEAD/LICENSE). `import('lighthouse')` succeeded on Node 22 and Bun; the compiled binary failed (section 6). No Chrome is installed in this sandbox so no audit was executed — [import tests](file:///tmp/claude-0/-home-user-omniforge-re/bf80d2cd-25a8-5324-8cbc-77653e50e83f/scratchpad/trial/t_lh.mjs)
- `chrome-launcher` 1.2.2 (Apache-2.0, 2026-09-29) — [npm](https://registry.npmjs.org/chrome-launcher); `playwright-lighthouse` 4.0.0 (MIT, 2024-01-15, stale) peers on `lighthouse` + `playwright-core` — [npm](https://registry.npmjs.org/playwright-lighthouse); `@lhci/cli` 0.15.1 (Apache-2.0, 2025-06-25) — [npm](https://registry.npmjs.org/@lhci%2fcli)
- **axe-core** 4.14.0 (MPL-2.0, published 2026-10-05, zero deps, ~7.7k stars). README: jsdom support is limited and the `color-contrast` rule is known not to work there. `@axe-core/playwright` 4.14.0 (MPL-2.0, published 2026-10-15, Node >=22.12, peer `playwright-core`) — [npm: axe-core](https://registry.npmjs.org/axe-core), [GitHub](https://github.com/dequelabs/axe-core), [npm: @axe-core/playwright](https://registry.npmjs.org/@axe-core%2fplaywright). OmniForge already runs axe (WCAG A/AA) in its *own* e2e suite — [FEATURES.md](file:///home/user/omniforge-re/FEATURES.md)
- **web-vitals** 6.2.3 (Apache-2.0, published 2026-10-05, zero deps, in-page library) — [npm](https://registry.npmjs.org/web-vitals), [LICENSE](https://raw.githubusercontent.com/GoogleChrome/web-vitals/HEAD/LICENSE)
- **Coverage / reporting**: Playwright `Coverage` class (above); `monocart-coverage-reports` 3.0.0 (MIT, published 2026-10-18, Node >=22.15, 17 deps); `v8-to-istanbul` 9.3.0 stale (2024-06-22) — [npm: monocart-coverage-reports](https://registry.npmjs.org/monocart-coverage-reports)
- **Serverless Chromium**: `@sparticuz/chromium` 153.0.0 (MIT, published 2026-09-11, Node `^22.17.0 || >=24.0.0`, 70 MB unpacked, ~1.7k stars) and `@sparticuz/chromium-min` (46 KB, binary fetched from a URL you host). README: `chromium.br` is over 50 MB; for vendors with size limits host the `chromium-v#-pack.tar` elsewhere (e.g. S3) and use `-min`; the npm package includes **x64 binaries only**; includes a "Usage with Playwright" example with `playwright-core` (`args: chromium.args`, `executablePath`). The fetched README/GitHub page documents AWS Lambda (and Netlify) but **does not mention Vercel** — [npm: @sparticuz/chromium](https://registry.npmjs.org/@sparticuz%2fchromium), [npm: -min](https://registry.npmjs.org/@sparticuz%2fchromium-min), [README](https://raw.githubusercontent.com/Sparticuz/chromium/HEAD/README.md), [GitHub](https://github.com/Sparticuz/chromium)
- **screenshot-to-code** (abi/screenshot-to-code): MIT, ~80.5k stars, 1,457 commits; Python/FastAPI backend + React/Vite frontend, Docker Compose; needs at least one of OpenAI/Anthropic/Gemini keys; not offline by default (Ollama "not recommended due to poor-quality results"); outputs HTML+Tailwind/CSS, React, Vue, Bootstrap, Ionic — [GitHub](https://github.com/abi/screenshot-to-code), [LICENSE](https://raw.githubusercontent.com/abi/screenshot-to-code/HEAD/LICENSE)
- **Parsers / structural tooling** (relevant to "larger analysis" and OmniForge's "tree-sitter not integrated"): `acorn` 8.19.0 (MIT, 2026-10-05, already used), `meriyah` 7.4.0 (ISC, 2026-10-05), `web-tree-sitter` 0.27.1 (MIT, WASM, 2026-10-08), `css-tree` 3.2.1 (MIT, 2026-03-05) — [acorn](https://registry.npmjs.org/acorn), [meriyah](https://registry.npmjs.org/meriyah), [web-tree-sitter](https://registry.npmjs.org/web-tree-sitter), [css-tree](https://registry.npmjs.org/css-tree)
- Vercel docs search returned only `vercel.json` examples (e.g. `"memory": 3009, "maxDuration": 60`), not the platform limits table — [Vercel documentation search](https://vercel.com/docs/functions/configuring-functions/advanced-configuration)

### Inferences
- Desktop pipeline with near-zero new dependencies: Playwright (already present) captures screenshot + HAR + trace + CDP coverage; inject axe via `@axe-core/playwright` for accessibility findings on the *target site* and web-vitals via an init script for LCP/CLS/INP evidence. Lighthouse is a heavier "full audit" option; launching Chromium with a remote-debugging port and passing it to Lighthouse is the usual pattern, but I did not verify it here.
- Hosted mode: `@sparticuz/chromium-min` with a self-hosted binary tarball is the only realistic path to screenshots on Vercel; whether it fits Vercel's function size, memory and the 60 s-class duration was **not verified** and should be proven with a spike before committing.
- screenshot-to-code should not be embedded (Python, keys required); OmniForge already routes vision-capable models, so a "screenshot → component" flow can reuse its provider router with prompts informed by that project's MIT-licensed approach.

### Gaps
- No browser exists in this sandbox, so Lighthouse, axe-in-browser, web-vitals and `@sparticuz/chromium` were not executed; claims are from metadata/docs only.
- Vercel function limits (bundle size, duration, memory) could not be fetched: `vercel.com` was unreachable for WebFetch and the docs-search tool returned only configuration examples.
- Lighthouse's exact programmatic requirements (debugging port vs Puppeteer page) were not confirmed from its docs; the README page fetched did not mention chrome-launcher.
- Design2Code (benchmark with layout/colour/text similarity metrics) could not be assessed: no licence file found, repo not otherwise examined.

---

## 8. Ranked shortlist for OmniForge RE (value vs effort vs risk), with integration mode

### Takeaway
Top picks are **webcrack + QuickJS sandbox + prettier**, **retire.js**, **pixelmatch (+ looks-same)**, then desktop-only Playwright-based capture/audit and archiving (**axe, web-vitals, warcio, Monolith**), with **wakaru** as an optional sidecar. Do **not** integrate Crawlee, Firecrawl, SingleFile, GPL fingerprint data or pa11y.

### Cited Findings
- All facts behind this ranking are cited in sections 1–7; key constraints are the Bun-compiled sidecar (JavaScriptCore, so no V8 native addons), `darwin-x64` build gaps (isolated-vm 6.2.0 prebuilds, wakaru npm packages), and the AGPL/GPL licences listed in section 6.
- OmniForge facts used: workspace has `packages/core`, `packages/server`, `packages/cli`, `apps/desktop`, `apps/web`; root engines `node >=22.19`; core deps include `acorn ^8.19.0`, `cheerio ^1.2.0`, `fflate ^0.8.3` — [package.json](file:///home/user/omniforge-re/package.json), [core package.json](file:///home/user/omniforge-re/packages/core/package.json)

### Inferences

Ranked list (facts and sources are in the sections named in the last column):

| # | Candidate | Licence | Recency (npm/GitHub) | Mode | Serverless (Vercel)? | Bun-compile? | Duplicates OmniForge? | Section |
|---|---|---|---|---|---|---|---|---|
| 1 | **webcrack 2.16.0 + QuickJS-WASM sandbox + prettier 3.9.10** | MIT / MIT / MIT | 2026-04-25 / 2026-02-16 / 2026-10-10; ~3.0k stars | library in `packages/core` (new "deobfuscate/unpack" step run on fetched JS) | Likely yes (pure JS+WASM; `isolated-vm` still installs but is never loaded); not deployed here | **Yes, tested** (singlefile QuickJS variant; +4.2 MB) | No (OmniForge has no deobfuscation) | 1 |
| 2 | **retire.js 6.1.0 + jsrepository-v5.json** | Apache-2.0 | 2026-10-06; ~4.2k stars | library + vendored 604 KB data file; feeds SBOM/OSV | Likely yes (pure JS, import-tested on Node) | Not tested | Partial: extends fingerprinting with versioned library detection + vuln data | 2 |
| 3 | **pixelmatch 8.0.0 (+ pngjs, optional looks-same 10.0.1)** | ISC / MIT / MIT | 2026-10-06 / 2025-08-18 | library: `visualDiff()` for rebuilt-vs-reference, closes FEATURES §17 steps 18–19 gap | Yes for the diff (needs images; capture is the hard part) | **Yes, tested** | No (no visual diff today) | 3 |
| 4 | **Playwright built-ins (screenshot, `recordHar`, tracing, `Coverage`) + axe-core/@axe-core/playwright + web-vitals** | Apache-2.0 / MPL-2.0 / Apache-2.0 | 2026-10-14 / 2026-10-15 / 2026-10-05 | desktop only (needs Chromium) | No (no browser on hosted mode) | n/a (runs in page / via existing playwright-core) | Partial: Playwright rendering exists; screenshot/audit/coverage evidence does not | 5, 7 |
| 5 | **warcio 2.4.12 (WARC) + Monolith (single-file HTML)** | Apache-2.0 / CC0-1.0 | 2026-09-04 / n.a. (~15.5k stars) | warcio: library (serverless-capable); Monolith: desktop sidecar binary | warcio likely yes; Monolith no | warcio untested; Monolith is a spawned binary | No (no page archiving today) | 5 |
| 6 | **wakaru 1.14.0 CLI** | Apache-2.0 | 2026-10-10; ~1.0k stars | optional desktop sidecar (spawn binary, 26.8 MB per platform) for webpack 5.112-era unpacking, `bun` container extraction | No | Spawned binary, not embedded; **no darwin-x64 on npm** | Complements #1 (webcrack missed new webpack format in test) | 1 |
| 7 | **LLM identifier-renaming pass (humanify concept)** | MIT concept | humanify v3 active, ~3.3k stars | reimplement in core using OmniForge provider router (AST rename, LLM only proposes names) | Yes if model call fits the time budget | Yes (own code) | No | 1 |
| 8 | **Lighthouse 13.5.0** | Apache-2.0 | 2026-09-18; ~30.9k stars | optional desktop child Node process; heavy (22 MB, 28 deps) | No | **No (compiled binary crashed)** | No | 7 |
| 9 | **@sparticuz/chromium-min 153.0.0** | MIT | 2026-09-11; ~1.7k stars | hosted screenshots, needs a hosted Chromium tarball | Unverified (README documents Lambda, not Vercel) | n/a | No | 7 |
| 10 | turndown + readability/defuddle (markdown extraction) | MIT / Apache-2.0 / MIT | 2026-04 / 2025-03 / 2026-10 | library; alternative to Firecrawl's markdown output | Yes (pure JS) | Not tested | No | 4 |
| — | **Reject:** Crawlee (policy/duplication), Firecrawl server (AGPL), SingleFile/single-file-cli (AGPL), GPL Wappalyzer-lineage data bundled in-app, synchrony/`deobfuscator` (GPL-3.0), pa11y (LGPL), HTTrack (GPL), browsertrix/replayweb.page (AGPL), unwebpack-sourcemap (archived), `@wakaru/unminify`/`unpacker` libraries (stale, fail in Node ESM) | — | — | — | — | — | — | 4, 5, 6 |

- Suggested spike order: (1) webcrack+QuickJS+prettier with a unit test on the obfuscator.io fixture and a mutation check that the sandbox rejects a `while(true)` payload; (2) pixelmatch `visualDiff` with a test that a changed region is detected and an identical image yields 0; (3) retire.js scan on collected scripts feeding the existing OSV step.
- Add the webpack-5.112 bundle (module-array export format) as a negative fixture so webcrack's unpack limitation is surfaced in reports as "not unpacked" instead of silently skipped, consistent with OmniForge's evidence-based coverage model.

### Gaps
- Ranking weights (value vs effort) are my judgement, not measured; no OmniForge integration code was written or run against these libraries.
- Serverless suitability is inferred from "pure JS/WASM, no native load" and was not deployed to Vercel; function bundle-size impact (webcrack's Babel stack, prettier ~10 MB, isolated-vm 21 MB if installed) was not measured against Vercel limits.
- Intel-macOS behaviour was not testable on this Linux sandbox.

---

## 9. Evidence quality, source access and method limits

### Takeaway
Licences were verified from raw LICENSE files and npm metadata; popularity/recency for GitHub-only projects relied on rounded star counts from rendered pages because the GitHub API is blocked. All "works / fails" statements for libraries come from my own runs on Linux x64 with Node 22.22.0 and Bun 1.4.2.

### Cited Findings
- `api.github.com` and `github.com` via curl returned 403 from the egress proxy, `gh api` reported the repository access "is not enabled for this session", and deps.dev, ecosyste.ms, shields.io, ungh.cc, api.npmjs.org, codeload.github.com and (via WebFetch) vercel.com were unreachable; reachable were registry.npmjs.org, raw.githubusercontent.com, gitlab.com, and github.com pages through the WebFetch tool — [proxy status endpoint](http://127.0.0.1:44363/__agentproxy/status), [proxy README](file:///root/.ccr/README.md)
- GitHub repo pages fetched through WebFetch showed rounded star counts (e.g. "3.0k") and commit counts but **no last-commit or release dates**, so recency is based on npm `time` fields (publish date of latest version) — e.g. [webcrack page](https://github.com/j4k0xb/webcrack)

### Inferences
- Star counts are approximate; last-commit dates are unknown for repos without npm releases (Monolith, wappalyzergo, nuclei-templates, enthec/webappanalyzer, screenshot-to-code, sourcemapper, jsluice).
- WebFetch summaries come from a small model; where a claim mattered (licences, versions, sizes) I cross-checked with raw files or the registry, but descriptive README paraphrases (Firecrawl self-host limits, Crawlee/humanify feature lists, screenshot-to-code models) remain second-hand.

### Gaps
- GitHub release/commit recency for non-npm projects; `BishopFox/jsluice` (MIT Go tool for URLs/secrets in JS, licence verified at [LICENSE](https://raw.githubusercontent.com/BishopFox/jsluice/HEAD/LICENSE)) was not otherwise examined and likely overlaps OmniForge's endpoint discovery.
- Not tested: Windows/macOS runtime behaviour; real-world large bundles; headless-Chromium tools (no browser in the sandbox); Vercel deployment.
- Local-test artefacts live in the session scratchpad (`SCR/trial`, `SCR/trial2`) and may not persist; the recipes are: install packages with `npm install --ignore-scripts`; obfuscate/minify a small sample with `javascript-obfuscator` and `terser`; call the libraries with default options; `bun build --compile` a script importing them and run the binary.
