import { describe, expect, it } from "vitest";
import { analyzeSourceTree, detectLanguage, extractImports, resolveInternal, sniffBinary } from "../src/analyze/source";
import { parseLockfile, parseManifest } from "../src/analyze/deps";

const enc = (s: string) => new TextEncoder().encode(s);
const f = (path: string, s: string) => ({ path, data: enc(s) });

describe("deps", () => {
  it("parses package.json with dev split and framework", () => {
    const m = parseManifest("package.json", JSON.stringify({ name: "x", main: "index.js", dependencies: { next: "^15", react: "19" }, devDependencies: { vitest: "3" } }))!;
    expect(m.framework).toBe("Next.js");
    expect(m.dependencies.find((d) => d.name === "vitest")!.dev).toBe(true);
    expect(m.dependencies.find((d) => d.name === "next")!.dev).toBe(false);
  });
  it("parses poetry + pep621 pyproject", () => {
    const toml = `[tool.poetry]\nname = "svc"\n[tool.poetry.dependencies]\npython = "^3.11"\nfastapi = "^0.110"\nhttpx = { version = "^0.27", extras = ["http2"] }\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\n`;
    const m = parseManifest("pyproject.toml", toml)!;
    expect(m.buildSystem).toBe("poetry");
    expect(m.dependencies.map((d) => d.name).sort()).toEqual(["fastapi", "httpx", "pytest"]);
    expect(m.dependencies.find((d) => d.name === "pytest")!.dev).toBe(true);
    const p2 = parseManifest("pyproject.toml", `[project]\nname="a"\ndependencies = [\n "requests>=2.31",\n "rich",\n]\n`)!;
    expect(p2.dependencies.map((d) => d.name)).toEqual(["requests", "rich"]);
  });
  it("parses Cargo inline + table + dev dependencies", () => {
    const toml = `[package]\nname="app"\n[dependencies]\nserde = { version = "1.0", features=["derive"] }\ntokio = "1"\n[dependencies.reqwest]\nversion = "0.12"\n[dev-dependencies]\ncriterion = "0.5"\n`;
    const m = parseManifest("Cargo.toml", toml)!;
    expect(m.dependencies.map((d) => `${d.name}@${d.version}${d.dev ? "!" : ""}`).sort()).toEqual(["criterion@0.5!", "reqwest@0.12", "serde@1.0", "tokio@1"]);
  });
  it("parses go.mod, Gemfile, pom, csproj", () => {
    expect(parseManifest("go.mod", "module ex.com/a\nrequire (\n github.com/x/y v1.2.3\n golang.org/z v0.1.0 // indirect\n)")!.dependencies).toHaveLength(2);
    expect(parseManifest("Gemfile", "gem 'rails', '~> 7.1'\ngem \"puma\"")!.dependencies.map((d) => d.name)).toEqual(["rails", "puma"]);
    expect(parseManifest("pom.xml", "<dependency><groupId>g</groupId><artifactId>a</artifactId><version>1</version></dependency>")!.dependencies[0]!.name).toBe("g:a");
    expect(parseManifest("A.csproj", `<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />`)!.dependencies[0]!.version).toBe("13.0.3");
  });
  it("returns null (not a throw) on malformed manifests", () => expect(parseManifest("package.json", "{not json")).toBeNull());
  it("reads lockfiles for exact versions", () => {
    const npm = parseLockfile("package-lock.json", JSON.stringify({ packages: { "": {}, "node_modules/a": { version: "1.0.0" }, "node_modules/a/node_modules/b": { version: "2.0.0", dev: true } } }));
    expect(npm.map((d) => `${d.name}@${d.version}`)).toEqual(["a@1.0.0", "b@2.0.0"]);
    expect(parseLockfile("Cargo.lock", `[[package]]\nname = "serde"\nversion = "1.0.200"\n\n[[package]]\nname = "x"\nversion = "0.1.0"\n`)).toHaveLength(2);
    expect(parseLockfile("pnpm-lock.yaml", `packages:\n  /left-pad@1.3.0:\n    resolution: {}\n  '@scope/pkg@2.1.0':\n    resolution: {}\n`).map((d) => d.name)).toEqual(["left-pad", "@scope/pkg"]);
    expect(parseLockfile("go.sum", "github.com/a/b v1.0.0 h1:x=\ngithub.com/a/b v1.0.0/go.mod h1:y=\n")).toHaveLength(1);
    expect(parseLockfile("package-lock.json", "garbage")).toEqual([]);
  });
});

describe("source detection", () => {
  it("detects by name, extension, shebang and content", () => {
    expect(detectLanguage("Dockerfile", "")).toBe("Dockerfile");
    expect(detectLanguage("a.tsx", "")).toBe("TypeScript");
    expect(detectLanguage("run", "#!/usr/bin/env python3\nprint(1)")).toBe("Python");
    expect(detectLanguage("page", "<!DOCTYPE html><html>")).toBe("HTML");
    expect(detectLanguage("data", '{"a":1}')).toBe("JSON");
  });
  it("sniffs binaries by magic bytes regardless of extension", () => {
    expect(sniffBinary(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1]))).toBe("elf");
    expect(sniffBinary(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]))).toBe("mach-o");
    expect(sniffBinary(new Uint8Array([0x4d, 0x5a, 0x90]))).toBe("pe");
    expect(sniffBinary(enc("plain text"))).toBeNull();
  });
  it("extracts imports across languages", () => {
    expect(extractImports("TypeScript", `import a from "./a"; import type {B} from '@x/y'; export * from "./c"; const d = require("e"); await import("f");`).sort()).toEqual(["./a", "./c", "@x/y", "e", "f"]);
    expect(extractImports("Python", "import os\nfrom .util import x\nfrom a.b import c").sort()).toEqual([".util", "a.b", "os"]);
    expect(extractImports("Go", 'import (\n "fmt"\n a "net/http"\n)')).toEqual(["fmt", "net/http"]);
    expect(extractImports("C++", '#include <vector>\n#include "mine.h"')).toEqual(["vector", "mine.h"]);
  });
  it("resolves internal imports incl. TS ESM .js→.ts", () => {
    const known = new Set(["src/a.ts", "src/lib/index.ts", "src/b.tsx"]);
    expect(resolveInternal("src/x.ts", "./a", known, "TypeScript")).toBe("src/a.ts");
    expect(resolveInternal("src/x.ts", "./lib", known, "TypeScript")).toBe("src/lib/index.ts");
    expect(resolveInternal("src/x.ts", "./a.js", known, "TypeScript")).toBe("src/a.ts");
    expect(resolveInternal("src/x.ts", "react", known, "TypeScript")).toBeNull();
  });
});

describe("analyzeSourceTree", () => {
  it("builds a full picture of a small Next.js app and never leaks secret values", async () => {
    const SECRET = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_"); // built at runtime: no secret-shaped literal in source
    const r = await analyzeSourceTree([
      f("package.json", JSON.stringify({ name: "demo", scripts: { build: "next build" }, dependencies: { next: "15", react: "19", zod: "4" } })),
      f("pnpm-lock.yaml", "packages:\n  /next@15.0.0:\n    resolution: {}\n"),
      f("app/page.tsx", `import { Card } from "../components/Card";\nexport default function Home(){ return <Card/> }`),
      f("app/dashboard/settings/page.tsx", `export default function S(){ return <div/> }`),
      f("components/Card.tsx", `export function Card(){ const r = fetch("/api/items"); return <div>{process.env.NEXT_PUBLIC_TITLE}</div> }`),
      f("prisma/schema.prisma", "model User {\n id Int @id\n}\nmodel Post {\n id Int @id\n}"),
      f("db/init.sql", "CREATE TABLE IF NOT EXISTS items (id int);"),
      f(".env.example", "DATABASE_URL=\nSTRIPE_KEY=\n"),
      f("lib/pay.ts", `const k = "${SECRET}";\nexport {}`),
      f("public/logo.png", "\x89PNG\r\n"),
      { path: "bin/tool", data: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0]) },
    ]);
    expect(r.frameworks).toContain("Next.js");
    expect(r.buildSystems).toContain("npm/node");
    expect(r.dependencies.some((d) => d.name === "next" && d.version === "15.0.0")).toBe(true); // from lockfile
    expect(r.routes.map((x) => x.route)).toEqual(["/", "/dashboard/settings"]);
    expect(r.components.map((c) => c.name)).toContain("Card");
    expect(r.endpoints.map((e) => e.url)).toContain("/api/items");
    expect(r.envVars.map((e) => e.name)).toEqual(expect.arrayContaining(["NEXT_PUBLIC_TITLE", "DATABASE_URL", "STRIPE_KEY"]));
    expect(r.databaseDefinitions.map((d) => d.kind).sort()).toEqual(["prisma", "sql"]);
    expect(r.databaseDefinitions.find((d) => d.kind === "prisma")!.detail).toContain("User, Post");
    expect(r.graph.edges.some((e) => e.source === "file:app/page.tsx" && e.target === "file:components/Card.tsx")).toBe(true);
    expect(r.graph.edges.some((e) => e.target === "module:zod" || e.target === "module:react")).toBe(false); // zod never imported in code
    expect(r.binaries.map((b) => b.path).sort()).toEqual(["bin/tool", "public/logo.png"]);
    expect(r.secretFiles.map((s) => s.path)).toEqual(["lib/pay.ts"]);
    expect(JSON.stringify(r.secretFiles)).not.toContain(SECRET);
    expect(r.entrypoints).toEqual(expect.arrayContaining(["app/page.tsx", "app/dashboard/settings/page.tsx"]));
    const ts = r.languages.find((l) => l.language === "TypeScript")!;
    expect(ts.files).toBe(4);
  });
});
