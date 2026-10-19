/** Detect installed developer tools, system facts and local inference runtimes. */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverLocalServices, type DiscoveredService } from "@omniforge/core";
import { augmentedPath, sanitizedEnv } from "./jobs.js";

export const exec = (cmd: string, args: string[], o: { timeoutMs?: number; cwd?: string } = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    execFile(cmd, args, { timeout: o.timeoutMs ?? 6000, cwd: o.cwd, env: sanitizedEnv(), maxBuffer: 4_000_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number | string }).code === "ENOENT" ? 127 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));

export function which(cmd: string): string | null {
  for (const dir of augmentedPath().split(path.delimiter)) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

export type ToolStatus = "available" | "not-installed" | "unsupported-platform" | "needs-configuration";
export interface ToolInfo { id: string; name: string; category: "vcs" | "runtime" | "build" | "reverse" | "analysis" | "ai-runtime" | "native"; status: ToolStatus; path?: string; version?: string; detail?: string; install?: string }

interface ToolDef { /** version output must match, else the binary is a different program with the same name (e.g. Linux `sg`) */ identity?: RegExp; id: string; name: string; category: ToolInfo["category"]; bins: string[]; versionArgs?: string[]; platforms?: NodeJS.Platform[]; install?: string; appBundles?: string[]; envDir?: string }

const TOOLS: ToolDef[] = [
  { id: "git", name: "Git", category: "vcs", bins: ["git"], versionArgs: ["--version"], install: "xcode-select --install" },
  { id: "node", name: "Node.js", category: "runtime", bins: ["node"], versionArgs: ["--version"], install: "brew install node" },
  { id: "npm", name: "npm", category: "runtime", bins: ["npm"], versionArgs: ["--version"] },
  { id: "pnpm", name: "pnpm", category: "runtime", bins: ["pnpm"], versionArgs: ["--version"], install: "npm i -g pnpm" },
  { id: "bun", name: "Bun", category: "runtime", bins: ["bun"], versionArgs: ["--version"], install: "brew install oven-sh/bun/bun" },
  { id: "python", name: "Python 3", category: "runtime", bins: ["python3"], versionArgs: ["--version"], install: "brew install python" },
  { id: "cargo", name: "Rust (cargo)", category: "build", bins: ["cargo"], versionArgs: ["--version"], install: "curl https://sh.rustup.rs | sh" },
  { id: "swift", name: "Swift", category: "build", bins: ["swift"], versionArgs: ["--version"], platforms: ["darwin", "linux"], install: "xcode-select --install" },
  { id: "xcodebuild", name: "Xcode", category: "build", bins: ["xcodebuild"], versionArgs: ["-version"], platforms: ["darwin"], install: "Install Xcode from the App Store" },
  { id: "java", name: "Java (JDK)", category: "runtime", bins: ["java"], versionArgs: ["-version"], install: "brew install openjdk" },
  { id: "docker", name: "Docker", category: "build", bins: ["docker"], versionArgs: ["--version"] },
  { id: "jadx", name: "JADX", category: "reverse", bins: ["jadx"], versionArgs: ["--version"], install: "brew install jadx" },
  { id: "ghidra", name: "Ghidra", category: "reverse", bins: ["ghidraRun", "analyzeHeadless"], envDir: "GHIDRA_INSTALL_DIR", install: "brew install --cask ghidra" },
  { id: "hopper", name: "Hopper Disassembler", category: "reverse", bins: ["hopper"], platforms: ["darwin"], appBundles: ["/Applications/Hopper Disassembler v4.app", "/Applications/Hopper Disassembler.app"], install: "Download from hopperapp.com (commercial licence)" },
  { id: "semgrep", name: "Semgrep", category: "analysis", bins: ["semgrep"], versionArgs: ["--version"], install: "brew install semgrep" },
  { id: "ast-grep", name: "ast-grep", category: "analysis", bins: ["ast-grep", "sg"], versionArgs: ["--version"], identity: /ast-grep/i, install: "brew install ast-grep" },
  { id: "noir", name: "OWASP Noir (endpoint discovery)", category: "analysis", bins: ["noir"], versionArgs: ["--version"], install: "brew install noir" },
  { id: "osv-scanner", name: "OSV-Scanner", category: "analysis", bins: ["osv-scanner"], versionArgs: ["--version"], install: "brew install osv-scanner" },
  { id: "repomix", name: "Repomix", category: "analysis", bins: ["repomix"], versionArgs: ["--version"], install: "npm i -g repomix" },
  { id: "rea", name: "Reverse Engineer Anything (rea)", category: "reverse", bins: ["rea"], versionArgs: ["--version"], install: "npm install --global rea-agents" },
  { id: "ollama", name: "Ollama", category: "ai-runtime", bins: ["ollama"], versionArgs: ["--version"], install: "brew install ollama", appBundles: ["/Applications/Ollama.app"] },
  { id: "lmstudio", name: "LM Studio", category: "ai-runtime", bins: ["lms"], versionArgs: ["version"], appBundles: ["/Applications/LM Studio.app"], install: "Download from lmstudio.ai" },
  { id: "llamacpp", name: "llama.cpp server", category: "ai-runtime", bins: ["llama-server"], versionArgs: ["--version"], install: "brew install llama.cpp" },
  { id: "unsloth", name: "Unsloth", category: "ai-runtime", bins: ["unsloth"], versionArgs: ["--help"], install: "See unsloth.ai/docs (Studio / Desktop)", appBundles: ["/Applications/Unsloth.app", "/Applications/Unsloth Studio.app"] },
  { id: "lipo", name: "lipo", category: "native", bins: ["lipo"], platforms: ["darwin"] },
  { id: "otool", name: "otool", category: "native", bins: ["otool"], platforms: ["darwin"] },
  { id: "codesign", name: "codesign", category: "native", bins: ["codesign"], platforms: ["darwin"] },
  { id: "plutil", name: "plutil", category: "native", bins: ["plutil"], platforms: ["darwin"] },
  { id: "objdump", name: "objdump", category: "native", bins: ["objdump"], versionArgs: ["--version"] },
  { id: "rizin", name: "Rizin", category: "native", bins: ["rizin"], versionArgs: ["-v"], install: "brew install rizin" },
];

export async function detectTools(): Promise<ToolInfo[]> {
  return Promise.all(TOOLS.map(async (t): Promise<ToolInfo> => {
    const base = { id: t.id, name: t.name, category: t.category, install: t.install };
    if (t.platforms && !t.platforms.includes(process.platform)) return { ...base, status: "unsupported-platform", detail: `Not available on ${process.platform}` };
    let p: string | null = null;
    for (const b of t.bins) { p = which(b); if (p) break; }
    if (!p && t.envDir && process.env[t.envDir]) { const d = process.env[t.envDir]!; for (const b of t.bins) { const c = path.join(d, b); if (fs.existsSync(c)) { p = c; break; } } }
    if (!p && t.appBundles) for (const a of t.appBundles) if (fs.existsSync(a)) { p = a; break; }
    if (!p) return { ...base, status: "not-installed" };
    if (t.identity && t.versionArgs) {
      // try each candidate binary until one identifies as the right program
      let ok = false;
      for (const b of t.bins) { const cand = which(b); if (!cand) continue; const r = await exec(cand, t.versionArgs, { timeoutMs: 5000 }); if (t.identity.test(r.stdout + r.stderr)) { p = cand; ok = true; break; } }
      if (!ok) return { ...base, status: "not-installed", detail: `A command named “${path.basename(p)}” exists but is not ${t.name}` };
    }
    let version: string | undefined;
    if (t.versionArgs && !p.endsWith(".app")) {
      const r = await exec(p, t.versionArgs, { timeoutMs: 5000 });
      const out = (r.stdout || r.stderr).trim().split("\n")[0] ?? "";
      version = out.match(/\d+\.\d+(?:\.\d+)?[\w.+-]*/)?.[0];
      if (r.code !== 0 && !version) return { ...base, status: "needs-configuration", path: p, detail: out.slice(0, 120) || "Installed but did not run correctly" };
    }
    return { ...base, status: "available", path: p, version };
  }));
}

export interface SystemInfo { platform: NodeJS.Platform; release: string; arch: string; nativeArch: string; rosetta: boolean; appleSilicon: boolean; cpus: number; memTotalGB: number; memFreeGB: number; home: string; hostname: string; node: string }

export async function systemInfo(): Promise<SystemInfo> {
  let nativeArch = os.arch();
  let rosetta = false;
  if (process.platform === "darwin") {
    const t = await exec("sysctl", ["-n", "sysctl.proc_translated"], { timeoutMs: 2000 });
    rosetta = t.stdout.trim() === "1";
    const a = await exec("uname", ["-m"], { timeoutMs: 2000 });
    if (a.stdout.trim()) nativeArch = a.stdout.trim() === "arm64" ? "arm64" : a.stdout.trim() === "x86_64" ? "x64" : os.arch();
    if (rosetta) nativeArch = "arm64"; // an x64 process on Apple Silicon is translated
  }
  return {
    platform: process.platform, release: os.release(), arch: process.arch, nativeArch, rosetta, appleSilicon: process.platform === "darwin" && nativeArch === "arm64",
    cpus: os.cpus().length, memTotalGB: Math.round((os.totalmem() / 1e9) * 10) / 10, memFreeGB: Math.round((os.freemem() / 1e9) * 10) / 10, home: os.homedir(), hostname: os.hostname(), node: process.version,
  };
}

export interface LocalRuntimes { services: DiscoveredService[]; mlx: { available: boolean; detail: string } }

export async function detectLocalRuntimes(): Promise<LocalRuntimes> {
  const services = await discoverLocalServices();
  let mlx = { available: false, detail: "python3 not found" };
  const py = which("python3");
  if (py) {
    const r = await exec(py, ["-c", "import mlx_lm,sys;print(getattr(mlx_lm,'__version__','installed'))"], { timeoutMs: 8000 });
    mlx = r.code === 0 ? { available: true, detail: `mlx_lm ${r.stdout.trim()}` } : { available: false, detail: "mlx_lm Python package not installed (pip install mlx-lm)" };
  }
  return { services, mlx };
}
