import { useApp } from "@/lib/store";
import { Segmented, Field, Input } from "@/components/ui/primitives";
import { Slider, ToggleRow } from "@/components/ui/overlay";
import type { CrawlConfig } from "@omniforge/core";

const MODES: { value: CrawlConfig["mode"]; label: string; title: string }[] = [
  { value: "single", label: "Single page", title: "Only the URL you enter" },
  { value: "selected", label: "Selected pages", title: "Exactly the URLs you list (no link following)" },
  { value: "domain", label: "Whole site", title: "Follow same-site links within the limits" },
  { value: "multi", label: "Multi-domain", title: "Follow links across all domains you entered" },
];

/** Crawl scope + politeness controls. Persisted in settings; applied to every website analysis. */
export function CrawlSettings({ hostedCaps }: { hostedCaps: boolean }) {
  const { settings, patchSettings, bridgeState } = useApp();
  const c = settings.crawl;
  const set = (p: Partial<CrawlConfig>) => patchSettings({ crawl: { ...c, ...p } });
  const desktop = bridgeState === "connected";
  const maxPagesCap = hostedCaps && !desktop ? 60 : 500;
  return (
    <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
      <div className="space-y-5">
        <Field label="Scope" group><Segmented value={c.mode ?? "domain"} onChange={(mode) => set({ mode })} options={MODES} size="sm" className="flex-wrap" /></Field>
        <Field label={`Depth: ${c.maxDepth ?? 3} link${(c.maxDepth ?? 3) === 1 ? "" : "s"} from the start page`}><Slider min={0} max={8} step={1} value={[c.maxDepth ?? 3]} onValueChange={([v]) => set({ maxDepth: v })} aria-label="Crawl depth" /></Field>
        <Field label={`Page limit: ${Math.min(c.maxPages ?? 40, maxPagesCap)}`} hint={hostedCaps && !desktop ? "The hosted service caps crawls at 60 pages. The desktop app allows up to 500." : undefined}><Slider min={1} max={maxPagesCap} step={1} value={[Math.min(c.maxPages ?? 40, maxPagesCap)]} onValueChange={([v]) => set({ maxPages: v })} aria-label="Page limit" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Parallel requests"><Input type="number" min={1} max={8} value={c.concurrency ?? 4} onChange={(e) => set({ concurrency: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })} /></Field>
          <Field label="Delay between requests (ms)"><Input type="number" min={0} max={5000} step={50} value={c.delayMs ?? 150} onChange={(e) => set({ delayMs: Math.max(0, Math.min(5000, Number(e.target.value) || 0)) })} /></Field>
        </div>
      </div>
      <div className="divide-y divide-line">
        <ToggleRow title="Respect robots.txt" desc="Skips disallowed paths and honours Crawl-delay. Leave on unless you own the site." checked={c.respectRobots !== false} onChange={(v) => set({ respectRobots: v })} />
        <ToggleRow title="Follow sitemaps" desc="Discovers pages listed in sitemap.xml (and robots.txt Sitemap lines)." checked={c.followSitemaps !== false} onChange={(v) => set({ followSitemaps: v })} />
        <ToggleRow title="Fetch scripts, styles & manifests" desc="Needed for technology detection, source maps and route discovery." checked={c.fetchAssets !== false} onChange={(v) => set({ fetchAssets: v })} />
        <ToggleRow title="Include subdomains" checked={!!c.includeSubdomains} onChange={(v) => set({ includeSubdomains: v })} />
        <ToggleRow title="Inspect external hosts" desc="Fetch third-party scripts (CDNs, analytics) to fingerprint them." checked={!!c.inspectExternal} onChange={(v) => set({ inspectExternal: v })} />
        <ToggleRow title="Render with a real browser" desc={desktop ? "Runs pages in headless Chromium to capture client-rendered routes and network calls. Only safe interactions (no form submits)." : "Needs the desktop app — the hosted service can't run a browser."} checked={!!c.render && desktop} onChange={(v) => set({ render: v })} disabled={!desktop} />
        <ToggleRow title="Make minified & obfuscated JavaScript readable" desc={desktop ? "Unminifies scripts, decodes obfuscator.io-style string arrays and splits webpack bundles, in a sandbox with no network or file access. The result is a reconstruction — original names and comments are not recoverable." : "Needs the desktop app — the sandboxed deobfuscation engine runs locally."} checked={!!c.deobfuscate && desktop} onChange={(v) => set({ deobfuscate: v })} disabled={!desktop} />
      </div>
    </div>
  );
}
