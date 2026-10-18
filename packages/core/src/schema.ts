/**
 * Shared OmniForge project data model.
 *
 * Both the web app and the macOS app read and write this exact shape, so a
 * project exported from one can be imported into the other.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

/** How a piece of knowledge was obtained (Section 24 of the spec). */
export const EVIDENCE_KINDS = [
  "observed", // directly observed (HTTP response, DOM, header)
  "recovered", // exact original code/asset retrieved (e.g. sourcesContent)
  "dynamic", // observed while executing/rendering
  "reconstructed", // readable form rebuilt from bundles/binaries
  "inferred", // concluded from behaviour or other evidence
  "unavailable", // examined but could not be obtained
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  method: string; // e.g. "http-get", "header-match", "acorn-ast", "sourcemap"
  source: string; // URL or artifact path
  hash?: string; // sha256 of the artifact where appropriate
  timestamp: string;
  confidence: number; // 0..1, derived from the rule, not from an LLM
  summary: string;
  snippet?: string; // short redacted excerpt
  related?: string[]; // ids of pages/assets/features/tech
}

export interface FormInfo {
  action: string;
  method: string;
  fields: { name: string; type: string; required: boolean; label?: string }[];
}

export interface Page {
  id: string;
  url: string;
  status: number;
  title: string;
  depth: number;
  contentType: string;
  bytes: number;
  hash: string;
  ms: number;
  discoveredFrom?: string;
  discoveredVia: "seed" | "link" | "sitemap" | "bundle-route" | "manual";
  links: string[];
  scripts: string[];
  styles: string[];
  images: string[];
  forms: FormInfo[];
  headings: { level: number; text: string }[];
  landmarks: string[];
  meta: Record<string, string>;
  interactive: { buttons: number; inputs: number; dialogs: number; links: number };
  a11y: { imagesWithoutAlt: number; inputsWithoutLabel: number; hasLang: boolean; hasMain: boolean };
  error?: string;
}

export const ASSET_KINDS = ["script", "style", "image", "font", "media", "manifest", "sourcemap", "wasm", "worker", "document", "other"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface Asset {
  id: string;
  url: string;
  kind: AssetKind;
  status?: number;
  bytes?: number;
  hash?: string;
  contentType?: string;
  fetched: boolean;
  skippedReason?: string;
  sourceMapUrl?: string;
  referencedBy: string[];
}

export interface Technology {
  name: string;
  category: string;
  version?: string;
  confidence: number;
  evidence: string[];
  website?: string;
}

export type FileProvenance = "recovered" | "reconstructed" | "user" | "generated";

export interface SourceFile {
  path: string;
  language: string;
  bytes: number;
  lines: number;
  hash: string;
  provenance: FileProvenance;
  origin: string;
  content?: string; // omitted for binaries and very large files
  truncated?: boolean;
  /** Secret-shaped values were replaced in `content` (kinds), or the content was withheld entirely (e.g. HAR captures). */
  redacted?: string[];
}

export interface Dependency {
  name: string;
  version?: string;
  ecosystem: "npm" | "pypi" | "cargo" | "go" | "maven" | "nuget" | "gem" | "composer" | "swift" | "cdn" | "other";
  dev?: boolean;
  source: string; // manifest path or URL
  evidence?: string;
}

export interface BehaviorSpec {
  purpose: string;
  inputs: string[];
  outputs: string[];
  states: string[];
  transitions: string[];
  dependencies: string[];
  errorStates: string[];
  accessibility: string[];
  hypotheses: string[];
}

export interface Feature {
  id: string;
  name: string;
  category: string;
  description: string;
  pages: string[];
  files: string[];
  evidence: string[];
  confidence: number;
  provenance: EvidenceKind;
  spec: BehaviorSpec;
}

export interface Finding {
  id: string;
  area: "performance" | "accessibility" | "security" | "seo" | "architecture" | "quality";
  severity: "info" | "low" | "medium" | "high";
  title: string;
  detail: string;
  evidence: string[];
}

export interface GraphNode {
  id: string;
  type: "page" | "asset" | "module" | "tech" | "feature" | "endpoint" | "file" | "service" | "dir";
  label: string;
  data?: Record<string, unknown>;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: "links" | "loads" | "imports" | "uses" | "calls" | "contains" | "implements";
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Endpoint {
  url: string;
  method?: string;
  kind: "rest" | "graphql" | "websocket" | "sse" | "unknown";
  foundIn: string;
  evidence: string;
}

export interface CoverageCheck {
  id: string;
  label: string;
  status: "done" | "partial" | "skipped" | "unavailable";
  detail: string;
}

export interface Coverage {
  /** done checks / applicable checks, computed from the list below (never guessed). */
  score: number;
  checks: CoverageCheck[];
}

export type TargetKind = "url" | "urls" | "repo" | "archive" | "files" | "folder" | "package" | "image" | "artifact";

export interface Target {
  id: string;
  kind: TargetKind;
  value: string; // URL, repo URL, or display name
  addedAt: string;
}

export interface CrawlConfig {
  mode: "single" | "selected" | "domain" | "multi";
  maxDepth: number;
  maxPages: number;
  maxAssetBytes: number;
  concurrency: number;
  delayMs: number;
  includeSubdomains: boolean;
  inspectExternal: boolean;
  respectRobots: boolean;
  fetchAssets: boolean;
  followSitemaps: boolean;
  render: boolean; // headless rendering (local worker / desktop only)
  deobfuscate: boolean; // unminify / deobfuscate / split bundles in a sandbox (local worker / desktop only)
  userAgent: string;
  allowedHosts: string[];
}

export const DEFAULT_CRAWL: CrawlConfig = {
  mode: "domain",
  maxDepth: 3,
  maxPages: 50,
  maxAssetBytes: 3_000_000,
  concurrency: 4,
  delayMs: 150,
  includeSubdomains: false,
  inspectExternal: false,
  respectRobots: true,
  fetchAssets: true,
  followSitemaps: true,
  render: false,
  deobfuscate: false,
  userAgent: "OmniForgeRE/1.0 (+https://github.com/CartyChris/omniforge-re; analysis crawler)",
  allowedHosts: [],
};

export interface LogEntry {
  t: string;
  level: "info" | "warn" | "error";
  msg: string;
}

export interface InvestigationStats {
  pages: number;
  assets: number;
  files: number;
  features: number;
  dependencies: number;
  technologies: number;
  evidence: number;
  endpoints: number;
  warnings: number;
  bytes: number;
}

export interface Investigation {
  id: string;
  name: string;
  targets: Target[];
  config: CrawlConfig;
  status: "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  progress: number; // 0..1
  pages: Page[];
  assets: Asset[];
  technologies: Technology[];
  files: SourceFile[];
  dependencies: Dependency[];
  endpoints: Endpoint[];
  features: Feature[];
  findings: Finding[];
  evidence: Evidence[];
  graph: Graph;
  coverage: Coverage;
  limitations: string[];
  questions: string[];
  log: LogEntry[];
  /** UI components seen in JS (AST) or recovered source. */
  components?: { name: string; source: string; provenance: EvidenceKind }[];
  /** Route strings with where they were seen. */
  routes?: { route: string; source: string; via: "link" | "sitemap" | "bundle" | "file-system" | "code" }[];
  designTokens?: { variables: Record<string, string>; colors: { value: string; count: number }[]; fonts: { value: string; count: number }[] };
  /** Third-party hosts contacted by pages/assets, with what they were loaded for. */
  thirdParties?: { host: string; kinds: string[]; count: number }[];
  envVars?: { name: string; files: string[] }[];
  /** Functions, classes, methods… parsed from source in any supported language (see analyze/structure.ts). */
  symbols?: { name: string; kind: string; file: string; line: number; language: string; container?: string }[];
  summary?: string; // optional AI-written overview (labelled as such in UI)
  /** Result of an explicit OSV.dev check of exact-version dependencies (see integrations/osv.ts). */
  vulnerabilities?: { checkedAt: string; checked: number; skipped: number; items: Vulnerability[] };
}

export interface Vulnerability {
  package: string;
  version: string;
  ecosystem: Dependency["ecosystem"];
  ids: string[]; // GHSA-…, CVE-…, PYSEC-… (deduplicated)
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  summary: string;
  fixed?: string[]; // versions that fix it, when OSV reports them
  source: string; // manifest/lockfile that declared the dependency
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  model?: string;
  at: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  agent?: string;
}

export type AgentRole = "discovery" | "reverse" | "architecture" | "development" | "uiux" | "testing" | "review" | "deployment";

export interface AgentTask {
  id: string;
  objective: string;
  role: AgentRole;
  inputs: string[];
  tools: string[];
  dependsOn: string[];
  acceptance: string[];
  status: "pending" | "running" | "done" | "failed" | "blocked" | "skipped";
  provider?: string;
  model?: string;
  logs: string[];
  output?: string;
  files?: string[];
  tests?: { name: string; pass: boolean; detail?: string }[];
  startedAt?: string;
  finishedAt?: string;
}

export interface Snapshot {
  id: string;
  label: string;
  at: string;
  files: Record<string, string>;
}

export interface BuildRecord {
  id: string;
  at: string;
  kind: "build" | "test" | "preview" | "export";
  ok: boolean;
  log: string;
}

export interface DeploymentRecord {
  id: string;
  at: string;
  provider: "vercel" | "github" | "local";
  url?: string;
  status: string;
  detail?: string;
}

export interface Project {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  localOnly: boolean;
  investigations: Investigation[];
  workspace: { files: Record<string, string>; open: string[]; active?: string };
  snapshots: Snapshot[];
  conversations: Conversation[];
  tasks: AgentTask[];
  builds: BuildRecord[];
  deployments: DeploymentRecord[];
  featureLibrary: string[]; // feature ids pinned to the library ("investigationId:featureId")
}

/* ------------------------------------------------------------------ */
/* Runtime validation for imported project files (untrusted input).    */
/* Nested collections are validated structurally but leniently so that */
/* older/newer minor versions still import.                            */
/* ------------------------------------------------------------------ */

const zLoose = z.record(z.string(), z.unknown());

export const ProjectFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1).max(200),
  name: z.string().max(500),
  description: z.string().max(20_000).default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
  localOnly: z.boolean().default(false),
  investigations: z.array(zLoose).max(500),
  workspace: z.object({
    files: z.record(z.string().max(1024), z.string()),
    open: z.array(z.string()).default([]),
    active: z.string().optional(),
  }),
  snapshots: z.array(zLoose).default([]),
  conversations: z.array(zLoose).default([]),
  tasks: z.array(zLoose).default([]),
  builds: z.array(zLoose).default([]),
  deployments: z.array(zLoose).default([]),
  featureLibrary: z.array(z.string()).default([]),
});
