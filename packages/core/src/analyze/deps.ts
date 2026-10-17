/**
 * Dependency and manifest detection across ecosystems. Parses known manifest
 * and lockfile formats; values that look like secrets are never emitted.
 */
import type { Dependency } from "../schema.js";

export interface ManifestResult {
  dependencies: Dependency[];
  buildSystem?: string;
  entrypoints: string[];
  scripts?: Record<string, string>;
  name?: string;
  framework?: string;
}

const FRAMEWORK_HINTS: Record<string, string> = {
  next: "Next.js", react: "React", "react-dom": "React", vue: "Vue.js", nuxt: "Nuxt", "@angular/core": "Angular",
  svelte: "Svelte", "@sveltejs/kit": "SvelteKit", astro: "Astro", "solid-js": "SolidJS", remix: "Remix",
  "@remix-run/react": "Remix", express: "Express", fastify: "Fastify", "@nestjs/core": "NestJS", koa: "Koa",
  "@tauri-apps/api": "Tauri", electron: "Electron", vite: "Vite", webpack: "Webpack",
};

function basename(path: string) {
  return path.split("/").pop() ?? path;
}

export function parseManifest(path: string, content: string): ManifestResult | null {
  const base = basename(path).toLowerCase();
  try {
    if (base === "package.json") return parsePackageJson(content);
    if (base === "requirements.txt") return parseRequirements(content, path);
    if (base === "pyproject.toml") return parsePyproject(content, path);
    if (base === "cargo.toml") return parseCargoToml(content, path);
    if (base === "go.mod") return parseGoMod(content, path);
    if (base === "composer.json") return parseComposer(content);
    if (base === "gemfile") return parseGemfile(content, path);
    if (base === "pom.xml") return parsePomXml(content, path);
    if (base === "build.gradle" || base === "build.gradle.kts") return parseGradle(content, path);
    if (base.endsWith(".csproj") || base === "packages.config") return parseCsproj(content, path);
  } catch {
    return null;
  }
  return null;
}

function parsePackageJson(content: string): ManifestResult {
  const pkg = JSON.parse(content);
  const deps: Dependency[] = [];
  const add = (obj: Record<string, string> | undefined, dev: boolean) => {
    for (const [name, version] of Object.entries(obj ?? {})) deps.push({ name, version: String(version), ecosystem: "npm", dev, source: "package.json" });
  };
  add(pkg.dependencies, false);
  add(pkg.devDependencies, true);
  add(pkg.peerDependencies, false);
  add(pkg.optionalDependencies, false);
  let framework: string | undefined;
  for (const d of deps) if (FRAMEWORK_HINTS[d.name] && !d.dev) framework ??= FRAMEWORK_HINTS[d.name];
  const entrypoints = [pkg.main, pkg.module, pkg.browser, typeof pkg.bin === "string" ? pkg.bin : undefined, ...(pkg.exports?.["."] ? [JSON.stringify(pkg.exports["."]).slice(0, 80)] : [])].filter(
    (x): x is string => typeof x === "string",
  );
  return { dependencies: deps, buildSystem: "npm/node", entrypoints, scripts: pkg.scripts, name: pkg.name, framework };
}

function parseRequirements(content: string, source: string): ManifestResult {
  const deps: Dependency[] = [];
  for (const line of content.split(/\r?\n/)) {
    const l = line.replace(/#.*$/, "").trim();
    if (!l || l.startsWith("-")) continue;
    const m = l.match(/^([A-Za-z0-9._-]+)\s*(?:\[[^\]]+\])?\s*([<>=!~]=?.+)?/);
    if (m) deps.push({ name: m[1]!, version: m[2]?.trim(), ecosystem: "pypi", source });
  }
  return { dependencies: deps, buildSystem: "pip", entrypoints: [] };
}

function parsePyproject(content: string, source: string): ManifestResult {
  const deps: Dependency[] = [];
  const pep621 = content.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (pep621) for (const m of pep621[1]!.matchAll(/["']([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*([<>=!~][^"']*)?["']/g)) deps.push({ name: m[1]!, version: m[2]?.trim(), ecosystem: "pypi", source });
  // [tool.poetry.dependencies] / [tool.poetry.group.*.dependencies]
  for (const sec of content.matchAll(/^\[tool\.poetry\.((?:group\.[\w-]+\.)?(?:dev-)?dependencies)\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) {
    const dev = /group\.|dev-/.test(sec[1]!);
    for (const m of sec[2]!.matchAll(/^([A-Za-z0-9._-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) {
      if (m[1]!.toLowerCase() === "python") continue;
      deps.push({ name: m[1]!, version: m[2] ?? m[3], ecosystem: "pypi", dev, source });
    }
  }
  const build = /\[tool\.poetry\]/.test(content) ? "poetry" : /\[tool\.hatch/.test(content) ? "hatch" : /\[tool\.pdm\]/.test(content) ? "pdm" : /\[tool\.uv\]/.test(content) ? "uv" : "pep-517";
  const name = content.match(/^\[(?:project|tool\.poetry)\][\s\S]*?^name\s*=\s*"([^"]+)"/m)?.[1];
  return { dependencies: deps, buildSystem: build, entrypoints: [], name };
}

function parseCargoToml(content: string, source: string): ManifestResult {
  const deps: Dependency[] = [];
  const blocks = content.split(/^\[/m).slice(1);
  for (const block of blocks) {
    const header = block.slice(0, block.indexOf("]"));
    const body = block.slice(block.indexOf("]") + 1);
    const inline = header.match(/^(?:workspace\.|target\.[^.]+\.)?(dev-|build-)?dependencies$/);
    if (inline) {
      for (const m of body.matchAll(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}\n]*?version\s*=\s*"([^"]+)")/gm))
        deps.push({ name: m[1]!, version: m[2] ?? m[3], ecosystem: "cargo", dev: inline[1] === "dev-", source });
      continue;
    }
    const table = header.match(/^(?:workspace\.|target\.[^.]+\.)?(dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/);
    if (table) deps.push({ name: table[2]!, version: body.match(/version\s*=\s*"([^"]+)"/)?.[1], ecosystem: "cargo", dev: table[1] === "dev-", source });
  }
  const name = content.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/)?.[1];
  const entrypoints = [...(/\[\[bin\]\]/.test(content) ? ["src/bin"] : []), "src/main.rs", "src/lib.rs"];
  return { dependencies: deps, buildSystem: "cargo", entrypoints, name };
}

function parseGoMod(content: string, source: string): ManifestResult {
  const deps: Dependency[] = [];
  const block = content.match(/require\s*\(([\s\S]*?)\)/);
  const lines = block ? block[1]!.split("\n") : content.split("\n").filter((l) => l.trim().startsWith("require "));
  for (const line of lines) {
    const m = line.replace(/^require\s+/, "").trim().match(/^([^\s]+)\s+(v[^\s/]+)/);
    if (m) deps.push({ name: m[1]!, version: m[2], ecosystem: "go", dev: /\/\/\s*indirect/.test(line), source });
  }
  const name = content.match(/^module\s+(.+)$/m)?.[1]?.trim();
  return { dependencies: deps, buildSystem: "go modules", entrypoints: ["main.go"], name };
}

function parseComposer(content: string): ManifestResult {
  const pkg = JSON.parse(content);
  const deps: Dependency[] = [];
  const add = (o: Record<string, string> | undefined, dev: boolean) => {
    for (const [name, version] of Object.entries(o ?? {})) if (name !== "php" && !name.startsWith("ext-")) deps.push({ name, version: String(version), ecosystem: "composer", dev, source: "composer.json" });
  };
  add(pkg.require, false);
  add(pkg["require-dev"], true);
  return { dependencies: deps, buildSystem: "composer", entrypoints: [], name: pkg.name };
}

function parseGemfile(content: string, source: string): ManifestResult {
  const deps: Dependency[] = [];
  for (const m of content.matchAll(/^\s*gem\s+["']([^"']+)["']\s*(?:,\s*["']([^"']+)["'])?/gm)) deps.push({ name: m[1]!, version: m[2], ecosystem: "gem", source });
  return { dependencies: deps, buildSystem: "bundler", entrypoints: [] };
}

function parsePomXml(content: string, source: string): ManifestResult {
  const deps: Dependency[] = [];
  for (const m of content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const g = m[1]!.match(/<groupId>([^<]+)<\/groupId>/)?.[1];
    const a = m[1]!.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1];
    const v = m[1]!.match(/<version>([^<]+)<\/version>/)?.[1];
    if (g && a) deps.push({ name: `${g}:${a}`, version: v, ecosystem: "maven", source });
  }
  return { dependencies: deps, buildSystem: "maven", entrypoints: [] };
}

function parseGradle(content: string, source: string): ManifestResult {
  const deps: Dependency[] = [];
  for (const m of content.matchAll(/(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*[("']+([A-Za-z0-9._-]+:[A-Za-z0-9._-]+):?([A-Za-z0-9._-]+)?/g))
    deps.push({ name: m[1]!, version: m[2], ecosystem: "maven", dev: /test/i.test(m[0]), source });
  return { dependencies: deps, buildSystem: "gradle", entrypoints: [] };
}

function parseCsproj(content: string, source: string): ManifestResult {
  const deps: Dependency[] = [];
  for (const m of content.matchAll(/<PackageReference\s+Include="([^"]+)"\s*(?:Version="([^"]+)")?/g)) deps.push({ name: m[1]!, version: m[2], ecosystem: "nuget", source });
  for (const m of content.matchAll(/<package\s+id="([^"]+)"\s+version="([^"]+)"/g)) deps.push({ name: m[1]!, version: m[2], ecosystem: "nuget", source });
  return { dependencies: deps, buildSystem: "dotnet", entrypoints: [] };
}

/** CDN script URLs → library dependencies (best-effort, flagged as cdn). */
export function depsFromCdnUrls(urls: string[]): Dependency[] {
  const out: Dependency[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    let m = url.match(/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com|cdn\.skypack\.dev|esm\.sh)\/(?:@([^/@]+)\/)?([^/@]+)@?([\d.]+[\w.-]*)?/);
    if (m) {
      const name = m[1] ? `@${m[1]}/${m[2]}` : m[2]!;
      if (!seen.has(name)) {
        seen.add(name);
        out.push({ name, version: m[3], ecosystem: "cdn", source: url });
      }
      continue;
    }
    m = url.match(/cdnjs\.cloudflare\.com\/ajax\/libs\/([^/]+)\/([\d.]+[\w.-]*)/);
    if (m && !seen.has(m[1]!)) {
      seen.add(m[1]!);
      out.push({ name: m[1]!, version: m[2], ecosystem: "cdn", source: url });
    }
  }
  return out;
}

/**
 * Resolved versions from lockfiles. Returns the exact installed set, which is
 * what vulnerability scanners (OSV) need rather than the semver ranges.
 */
export function parseLockfile(path: string, content: string): Dependency[] {
  const base = path.split("/").pop()!.toLowerCase();
  const out: Dependency[] = [];
  try {
    if (base === "package-lock.json") {
      const lock = JSON.parse(content);
      for (const [key, v] of Object.entries<any>(lock.packages ?? {})) {
        if (!key) continue;
        const name = key.split("node_modules/").pop()!;
        if (name && v?.version) out.push({ name, version: v.version, ecosystem: "npm", dev: !!v.dev, source: path });
      }
      if (!lock.packages) for (const [name, v] of Object.entries<any>(lock.dependencies ?? {})) out.push({ name, version: v.version, ecosystem: "npm", dev: !!v.dev, source: path });
    } else if (base === "pnpm-lock.yaml") {
      for (const m of content.matchAll(/^\s{2}['"]?(\/?(?:@[^/@\s'"]+\/)?[^/@\s'"]+)@(\d[^(:'"\s]*)/gm)) out.push({ name: m[1]!.replace(/^\//, ""), version: m[2], ecosystem: "npm", source: path });
    } else if (base === "yarn.lock") {
      for (const m of content.matchAll(/^"?((?:@[^/@\s"]+\/)?[^@\s"]+)@[^\n]*:\n\s+version:?\s+"?([^"\n]+)"?/gm)) out.push({ name: m[1]!, version: m[2], ecosystem: "npm", source: path });
    } else if (base === "cargo.lock") {
      for (const m of content.matchAll(/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g)) out.push({ name: m[1]!, version: m[2], ecosystem: "cargo", source: path });
    } else if (base === "poetry.lock") {
      for (const m of content.matchAll(/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g)) out.push({ name: m[1]!, version: m[2], ecosystem: "pypi", source: path });
    } else if (base === "go.sum") {
      const seen = new Set<string>();
      for (const m of content.matchAll(/^(\S+)\s+(v[^\s/]+)(?:\/go\.mod)?\s+h1:/gm)) {
        const k = `${m[1]}@${m[2]}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ name: m[1]!, version: m[2], ecosystem: "go", source: path });
        }
      }
    } else if (base === "composer.lock") {
      const lock = JSON.parse(content);
      for (const p of lock.packages ?? []) out.push({ name: p.name, version: p.version, ecosystem: "composer", source: path });
      for (const p of lock["packages-dev"] ?? []) out.push({ name: p.name, version: p.version, ecosystem: "composer", dev: true, source: path });
    } else if (base === "gemfile.lock") {
      for (const m of content.matchAll(/^ {4}([A-Za-z0-9_.-]+) \(([^)]+)\)$/gm)) out.push({ name: m[1]!, version: m[2], ecosystem: "gem", source: path });
    }
  } catch {
    /* malformed lockfile: return what we have */
  }
  return out;
}

export const LOCKFILE_RE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/;
