import { Bot, Boxes, CodeXml, Cpu, GitFork, LayoutDashboard, Microscope, Plug, Puzzle, Rocket, ScanSearch, Settings, type LucideIcon } from "lucide-react";

export interface NavItem { id: string; to: string; label: string; short?: string; icon: LucideIcon; chord: string; desc: string; mobile?: boolean }
export const NAV: NavItem[] = [
  { id: "dashboard", to: "/", label: "Dashboard", icon: LayoutDashboard, chord: "d", desc: "Projects, jobs, providers and status at a glance", mobile: true },
  { id: "analyze", to: "/analyze", label: "Analyze", icon: ScanSearch, chord: "a", desc: "Paste a URL or repo, or drop files — start an investigation", mobile: true },
  { id: "repo-rip", to: "/repo-rip", label: "Repo Rip", icon: GitFork, chord: "r", desc: "Clone, re-create or mesh GitHub repositories" },
  { id: "investigations", to: "/investigations", label: "Investigations", short: "Cases", icon: Microscope, chord: "i", desc: "Evidence-backed analysis reports, graphs and features", mobile: true },
  { id: "applications", to: "/applications", label: "Applications", short: "Apps", icon: Boxes, chord: "p", desc: "Your projects — open, import, export, checkpoint" },
  { id: "features", to: "/features", label: "Feature Library", short: "Features", icon: Puzzle, chord: "f", desc: "Discovered features as reusable, recreatable cards" },
  { id: "studio", to: "/studio", label: "AI Studio", short: "AI", icon: Bot, chord: "s", desc: "Providers, models, routing and agent task graphs" },
  { id: "workspace", to: "/workspace", label: "Code Workspace", short: "Code", icon: CodeXml, chord: "w", desc: "Editor, preview, terminal, git and tests", mobile: true },
  { id: "models", to: "/models", label: "Local Models", short: "Models", icon: Cpu, chord: "m", desc: "Ollama, LM Studio, llama.cpp, MLX, Unsloth" },
  { id: "integrations", to: "/integrations", label: "Integrations", icon: Plug, chord: "n", desc: "GitHub, Vercel, REA, AI CLIs, desktop companion" },
  { id: "deployments", to: "/deployments", label: "Deployments", icon: Rocket, chord: "y", desc: "Ship to Vercel/GitHub with verified URLs" },
  { id: "settings", to: "/settings", label: "Settings", icon: Settings, chord: "e", desc: "Theme, privacy, security, data" },
];
