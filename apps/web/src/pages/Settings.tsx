import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Download, Eye, FileClock, History, KeyRound, Lock, LockOpen, Moon, RotateCcw, ShieldCheck, Sun, Trash2, Upload } from "lucide-react";
import { exportProject, importProject, type Project } from "@omniforge/core";
import { strToU8, unzipSync, zipSync } from "fflate";
import { DEFAULT_SETTINGS, useApp, type Settings as S } from "@/lib/store";
import { db, ls } from "@/lib/storage";
import { vault } from "@/lib/vault";
import { appLog } from "@/lib/log";
import { clearAudit, readAudit, subscribeAudit, type AuditEntry } from "@/lib/audit";
import { download } from "@/lib/utils";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Field, Input, SectionTitle, Segmented, CopyButton } from "@/components/ui/primitives";
import { Dialog, DialogContent, Tabs, TabsContent, TabsList, TabsTrigger, ToggleRow } from "@/components/ui/overlay";
import { CrawlSettings } from "@/components/domain/CrawlSettings";
import { DEFAULT_CRAWL } from "@omniforge/core";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";

export default function Settings() {
  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <SectionTitle title="Settings" sub="Appearance, privacy, security, data and diagnostics. Nothing here is sent anywhere." />
      <Tabs defaultValue="general">
        <TabsList><TabsTrigger value="general">General</TabsTrigger><TabsTrigger value="privacy">Privacy & security</TabsTrigger><TabsTrigger value="crawl">Crawling</TabsTrigger><TabsTrigger value="data">Data</TabsTrigger><TabsTrigger value="diag">Diagnostics</TabsTrigger></TabsList>
        <div className="space-y-5 pt-5">
          <TabsContent value="general"><General /></TabsContent>
          <TabsContent value="privacy"><Privacy /></TabsContent>
          <TabsContent value="crawl"><Card><CardHeader><CardTitle>Default crawl settings</CardTitle><Button size="xs" variant="ghost" onClick={() => useApp.getState().patchSettings({ crawl: DEFAULT_SETTINGS.crawl })}>Reset</Button></CardHeader><CardBody><CrawlSettings hostedCaps /></CardBody></Card></TabsContent>
          <TabsContent value="data"><Data /></TabsContent>
          <TabsContent value="diag"><Diagnostics /></TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function General() {
  const { settings, patchSettings } = useApp();
  return (
    <div className="space-y-5">
      <Card><CardHeader><CardTitle>Appearance</CardTitle></CardHeader><CardBody className="divide-y divide-line">
        <div className="flex items-center justify-between gap-4 pb-3"><div><p className="text-sm font-medium">Theme</p><p className="text-xs text-muted">Dark is the default. Applies instantly.</p></div><Segmented value={settings.theme} onChange={(theme) => patchSettings({ theme })} options={[{ value: "dark", label: <span className="flex items-center gap-1.5"><Moon className="size-3.5" />Dark</span> }, { value: "light", label: <span className="flex items-center gap-1.5"><Sun className="size-3.5" />Light</span> }]} /></div>
        <ToggleRow title="Expanded sidebar" desc="Show section names next to the icons (desktop)." checked={settings.sidebarExpanded} onChange={(v) => patchSettings({ sidebarExpanded: v })} />
        <ToggleRow title="Open results automatically" desc="Jump to the investigation when an analysis finishes." checked={settings.autoOpenResults} onChange={(v) => patchSettings({ autoOpenResults: v })} />
      </CardBody></Card>
      <Card><CardHeader><CardTitle>AI routing</CardTitle></CardHeader><CardBody className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-sm font-medium">Optimise for</p><p className="text-xs text-muted">How OmniForge picks a model when you haven't assigned one to a task.</p></div><Segmented value={settings.optimise} onChange={(optimise) => patchSettings({ optimise })} options={[{ value: "quality", label: "Quality" }, { value: "cost", label: "Cost" }, { value: "latency", label: "Speed" }]} /></div>
        <Field label="Spending cap per session (USD)" hint="Cloud calls stop (or fall back to a configured fallback model) once this is reached. Blank = no cap."><Input type="number" min={0} step={0.5} className="max-w-40" value={settings.maxCostUsd ?? ""} onChange={(e) => patchSettings({ maxCostUsd: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })} placeholder="No cap" /></Field>
        <p className="text-xs text-faint">Per-task model assignments live in AI Studio → Routing.</p>
      </CardBody></Card>
    </div>
  );
}

function Privacy() {
  const { settings, patchSettings } = useApp();
  const [mode, setMode] = useState<"device" | "passphrase" | "keychain">("device"); const [locked, setLocked] = useState(false); const [names, setNames] = useState<string[]>([]);
  const [pass, setPass] = useState(""); const [open, setOpen] = useState<"set" | "unlock" | "wipe" | null>(null);
  const refresh = async () => { setMode(await vault.mode()); setLocked(await vault.locked()); setNames(await vault.names()); };
  useEffect(() => { void refresh(); }, []);
  const act = async (fn: () => Promise<void>, ok: string) => { try { await fn(); toast.success(ok); setOpen(null); setPass(""); await refresh(); } catch (e) { toast.error((e as Error).message); } };
  return (
    <div className="space-y-5">
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" />Privacy mode</CardTitle></CardHeader><CardBody className="divide-y divide-line">
        <ToggleRow title="Local-only mode" desc="Never send analysed content to a cloud AI provider. Only local models (Ollama, LM Studio, llama.cpp, MLX, Unsloth) are used; cloud providers are disabled everywhere, including agents and Q&A." checked={settings.localOnly} onChange={(v) => patchSettings({ localOnly: v })} />
        <div className="space-y-2 pt-3 text-[13px] text-muted"><p className="font-medium text-fg">What leaves your browser</p><ul className="list-disc space-y-1 pl-5"><li>Website analysis: the target URL goes to the OmniForge analysis service (or your desktop app) so pages can be fetched from a server, not your browser.</li><li>Files, ZIPs and folders you add are analysed in your browser and never uploaded.</li><li>AI calls go only to the providers you configured, with fenced, secret-redacted excerpts.</li><li>Your credentials are encrypted on this device and sent only to their own service.</li></ul></div>
      </CardBody></Card>
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="size-4" />Credential vault</CardTitle><Badge tone={locked ? "warn" : "ok"} dot>{locked ? "Locked" : mode === "keychain" ? "macOS Keychain" : mode === "passphrase" ? "Passphrase-protected" : "Device-encrypted"}</Badge></CardHeader><CardBody className="space-y-4">
        <p className="text-[13px] text-muted">{mode === "keychain" ? "API keys and tokens are stored in the macOS Keychain, never in project exports, settings or the app's own files. macOS protects them with your login." : <>API keys and tokens are AES-GCM encrypted in this browser's storage, never in project exports or settings. {mode === "device" ? "Add a passphrase so they can't be used by anyone with access to this browser profile." : "The passphrase is never stored; you unlock the vault once per session."}</>}</p>
        <div className="flex flex-wrap gap-2">
          {mode === "device" && <Button variant="secondary" icon={<Lock className="size-4" />} onClick={() => setOpen("set")}>Set passphrase</Button>}
          {mode === "passphrase" && locked && <Button variant="primary" icon={<LockOpen className="size-4" />} onClick={() => setOpen("unlock")}>Unlock</Button>}
          {mode === "passphrase" && !locked && <><Button variant="secondary" icon={<Lock className="size-4" />} onClick={() => { vault.lock(); void refresh(); }}>Lock now</Button><Button variant="ghost" onClick={() => act(() => vault.disablePassphrase(), "Passphrase removed (device encryption)")}>Remove passphrase</Button></>}
          <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setOpen("wipe")}>Erase all credentials</Button>
        </div>
        <div><p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-faint">Stored credentials (names only)</p>{names.length ? <div className="flex flex-wrap gap-1.5">{names.map((n) => <Badge key={n}>{n}</Badge>)}</div> : <p className="text-[13px] text-muted">{locked ? "Unlock to see names." : "None stored."}</p>}</div>
      </CardBody></Card>
      <Dialog open={open === "set" || open === "unlock"} onOpenChange={(o) => !o && setOpen(null)}><DialogContent title={open === "set" ? "Set a passphrase" : "Unlock the vault"} description={open === "set" ? "Min. 8 characters. There is no recovery if you forget it — you would re-enter your keys." : undefined}><form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void (open === "set" ? act(() => vault.enablePassphrase(pass), "Passphrase set") : act(() => vault.unlock(pass), "Unlocked")); }}><Input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} autoComplete={open === "set" ? "new-password" : "current-password"} aria-label="Passphrase" /><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(null)}>Cancel</Button><Button type="submit" variant="primary" disabled={pass.length < (open === "set" ? 8 : 1)}>{open === "set" ? "Set passphrase" : "Unlock"}</Button></div></form></DialogContent></Dialog>
      <Dialog open={open === "wipe"} onOpenChange={(o) => !o && setOpen(null)}><DialogContent title="Erase all credentials?" description="Provider keys and GitHub/Vercel tokens are deleted from this browser. Your projects are untouched."><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(null)}>Keep</Button><Button variant="danger" onClick={() => act(() => vault.wipe(), "Credentials erased")}>Erase</Button></div></DialogContent></Dialog>
    </div>
  );
}

function Data() {
  const { projects, project, importProjectFile } = useApp(); const fileRef = useRef<HTMLInputElement>(null); const restoreRef = useRef<HTMLInputElement>(null);
  const [wipe, setWipe] = useState(false); const [usage, setUsage] = useState<string>("");
  useEffect(() => { void navigator.storage?.estimate?.().then((e) => setUsage(`${((e.usage ?? 0) / 1e6).toFixed(1)} MB used${e.quota ? ` of ${(e.quota / 1e9).toFixed(1)} GB` : ""}`)).catch(() => {}); }, []);
  const backupAll = async () => {
    const files: Record<string, Uint8Array> = {};
    for (const i of projects) { const p = i.id === project?.id ? project : await db.get<Project>(`project:${i.id}`); if (p) files[`${slug(p.name)}-${p.id.slice(-6)}.omniforge.zip`] = exportProject(p); }
    files["BACKUP.txt"] = strToU8(`OmniForge RE backup — ${new Date().toISOString()}\n${Object.keys(files).length} project(s). Restore from Settings → Data. Credentials are never included.\n`);
    download(`omniforge-backup-${new Date().toISOString().slice(0, 10)}.zip`, zipSync(files, { level: 0 }), "application/zip");
  };
  const restore = async (f?: File) => {
    if (!f) return;
    try { const z = unzipSync(new Uint8Array(await f.arrayBuffer())); let n = 0; for (const [k, v] of Object.entries(z)) if (k.endsWith(".omniforge.zip")) { importProject(v); await importProjectFile(v); n++; } n ? toast.success(`Restored ${n} project(s)`) : toast.error("That isn't an OmniForge backup (no project files inside)."); }
    catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="space-y-5">
      <Card><CardHeader><CardTitle>Backup & restore</CardTitle><span className="text-xs text-muted">{usage}</span></CardHeader><CardBody className="space-y-3">
        <p className="text-[13px] text-muted">Everything is stored in this browser. Back up all {projects.length} project{projects.length === 1 ? "" : "s"} to one ZIP (credentials excluded), and restore it here or in the macOS app.</p>
        <div className="flex flex-wrap gap-2"><Button variant="primary" icon={<Download className="size-4" />} onClick={backupAll}>Back up everything</Button><input ref={restoreRef} type="file" accept=".zip" hidden onChange={(e) => { void restore(e.target.files?.[0]); e.target.value = ""; }} /><Button variant="secondary" icon={<Upload className="size-4" />} onClick={() => restoreRef.current?.click()}>Restore backup</Button><input ref={fileRef} type="file" accept=".zip,.json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) { try { await importProjectFile(new Uint8Array(await f.arrayBuffer())); toast.success("Project imported"); } catch (er) { toast.error((er as Error).message); } } e.target.value = ""; }} /><Button variant="ghost" onClick={() => fileRef.current?.click()}>Import one project…</Button></div>
        {!db.persistent() && <p className="text-xs text-warn">Browser storage is unavailable (private window?). Your work lives in memory only — back up before closing the tab.</p>}
      </CardBody></Card>
      <Card className="border-bad/30"><CardHeader><CardTitle className="text-bad">Danger zone</CardTitle></CardHeader><CardBody className="flex flex-wrap items-center justify-between gap-3"><p className="text-[13px] text-muted">Delete every project, setting and credential stored by OmniForge in this browser.</p><Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setWipe(true)}>Erase all local data</Button></CardBody></Card>
      <Dialog open={wipe} onOpenChange={setWipe}><DialogContent title="Erase all local data?" description="This cannot be undone. Make a backup first if you need anything."><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setWipe(false)}>Cancel</Button><Button variant="danger" onClick={async () => { for (const k of await db.keys()) await db.del(k); try { Object.keys(localStorage).filter((k) => k.startsWith("omniforge")).forEach((k) => localStorage.removeItem(k)); } catch { /* blocked */ } location.reload(); }}>Erase everything</Button></div></DialogContent></Dialog>
    </div>
  );
}

function AuditCard() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  useEffect(() => { let on = true; const load = () => void readAudit().then((r) => on && setRows([...r])); load(); const off = subscribeAudit(load); return () => { on = false; off(); }; }, []);
  return (
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><History className="size-4" />Audit trail</CardTitle><div className="flex gap-1.5"><Button size="xs" variant="ghost" icon={<Download className="size-3.5" />} disabled={!rows.length} onClick={() => download("omniforge-audit.json", JSON.stringify(rows, null, 2), "application/json")}>Export</Button><Button size="xs" variant="ghost" disabled={!rows.length} onClick={() => void clearAudit().then(() => toast.success("Audit trail cleared"))}>Clear</Button></div></CardHeader>
      <div className="max-h-60 overflow-auto p-3 font-mono text-xs leading-relaxed" role="log" aria-label="Audit trail" data-testid="audit-trail">
        {rows.length === 0 ? <span className="text-faint">Nothing recorded yet. Approvals, credential changes, privacy-mode changes, imports, exports, deletions and analyses are listed here (names only — never secret values).</span> : rows.slice().reverse().map((r, i) => <div key={i} className={r.action === "denied" ? "text-warn" : "text-muted"}><span className="text-faint">{new Date(r.t).toLocaleString([], { hour12: false })}</span> <span className="text-fg">{r.action}</span>{r.detail ? ` — ${r.detail}` : ""}</div>)}
      </div>
    </Card>
  );
}

function Diagnostics() {
  const lines = useSyncExternalStore(appLog.subscribe, appLog.all);
  const { settings, patchSettings, bridgeState, bridgeInfo, project, models, modelErrors } = useApp();
  const [prev, setPrev] = useState<S[]>(() => ls.get<S[]>("omniforge.settings.history", []));
  const diag = JSON.stringify({ app: "OmniForge RE web", time: new Date().toISOString(), ua: navigator.userAgent, storagePersistent: db.persistent(), bridge: bridgeState, bridgeVersion: bridgeInfo?.version, platform: bridgeInfo?.system, project: project ? { files: Object.keys(project.workspace.files).length, investigations: project.investigations.length } : null, models: models.length, modelErrors: modelErrors.map((e) => `${e.provider}: ${e.error}`), settings: { ...settings } }, null, 2);
  const restore = (s: S) => { patchSettings(s); setPrev(ls.get<S[]>("omniforge.settings.history", [])); toast.success("Previous settings restored"); };
  return (
    <div className="space-y-5">
      <Card><CardHeader><CardTitle>Restore previous configuration</CardTitle><Button size="xs" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => { patchSettings(DEFAULT_SETTINGS); toast.success("Settings reset to defaults"); }}>Reset to defaults</Button></CardHeader><CardBody>
        {prev.length === 0 ? <p className="text-[13px] text-muted">No earlier configurations yet. Each change to your settings is remembered here (without any credentials).</p> : <ul className="divide-y divide-line rounded-lg border border-line">{prev.slice(0, 5).map((s, i) => <li key={i} className="flex flex-wrap items-center gap-3 px-3 py-2 text-[13px]"><div className="min-w-0 flex-1"><span className="font-medium">{s.theme}</span> theme · {s.localOnly ? "local-only" : "cloud allowed"} · optimise {s.optimise} · crawl {s.crawl.maxPages ?? "?"} pages</div><Button size="xs" variant="secondary" onClick={() => restore(s)}>Restore</Button></li>)}</ul>}
      </CardBody></Card>
      <AuditCard />
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><FileClock className="size-4" />Logs</CardTitle><div className="flex gap-1.5"><CopyButton text={lines.map((l) => `${new Date(l.t).toISOString()} ${l.level.toUpperCase()} [${l.src}] ${l.msg}`).join("\n")} label="Copy" /><Button size="xs" variant="ghost" onClick={() => appLog.clear()}>Clear</Button></div></CardHeader>
        <div className="max-h-72 overflow-auto p-3 font-mono text-xs leading-relaxed" role="log">{lines.length === 0 ? <span className="text-faint">No events recorded this session.</span> : lines.slice().reverse().map((l, i) => <div key={i} className={l.level === "error" ? "text-bad" : l.level === "warn" ? "text-warn" : "text-muted"}><span className="text-faint">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span> [{l.src}] {l.msg}</div>)}</div></Card>
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><Eye className="size-4" />System report</CardTitle><CopyButton text={diag} label="Copy" /></CardHeader><CardBody><pre className="max-h-64 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs">{diag}</pre><p className="mt-2 text-xs text-faint">Contains no keys, tokens or analysed content. Safe to paste into a bug report.</p></CardBody></Card>
      <p className="text-center text-xs text-faint">OmniForge RE v1.0 · <a className="underline" href="https://github.com/CartyChris/omniforge-re" target="_blank" rel="noopener noreferrer">source & releases</a></p>
    </div>
  );
}
