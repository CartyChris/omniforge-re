import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppWindow, FolderOpen, FolderPlus, Lock, Microscope, ScanSearch, Trash2 } from "lucide-react";
import { useApp, isDesktop } from "@/lib/store";
import { analyzeLocalFolder, inspectLocalPackage } from "@/lib/analyze";
import { addRoot, listRoots, listTree, pickFolderNative, removeRoot, runRea, type ReaOpInfo, type RootInfo } from "@/lib/local";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input } from "@/components/ui/primitives";
import { Select } from "@/components/ui/overlay";
import { useNavigate } from "react-router";

const PKG = /\.(app|asar|apk|ipa|jar|war|aar|dmg|pkg|exe|dll|msi|deb|rpm|appimage|wasm|so|dylib|node|zip|tar|tgz|gz)$/i;

/** Desktop-only analysis: local folders, installed apps/packages/binaries, and REA deep analysis. Honest disabled state on the web. */
export function LocalTargets() {
  const { bridge, bridgeState, bridgeInfo } = useApp();
  const nav = useNavigate();
  const connected = bridgeState === "connected" && !!bridge;
  const canApprove = bridge?.conn.kind === "ui";
  const [roots, setRoots] = useState<RootInfo[]>([]);
  const [root, setRoot] = useState<string>("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [pkg, setPkg] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [ops, setOps] = useState<ReaOpInfo[]>([]);
  const [op, setOp] = useState("inspect-artifact");
  const reaOk = bridgeInfo?.rea?.status === "available";

  const refresh = async () => { try { const r = await listRoots(); setRoots(r); if (!r.find((x) => x.id === root)) setRoot(r[0]?.id ?? ""); } catch { /* shown via connection state */ } };
  useEffect(() => { if (connected) { void refresh(); bridge!.get<ReaOpInfo[]>("/bridge/rea/ops").then((o) => setOps(o.filter((x) => !x.platforms || x.platforms.includes(bridgeInfo?.system.platform ?? "")))).catch(() => setOps([])); } }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!connected || !root) { setCandidates([]); return; } listTree(root).then((t) => setCandidates(t.entries.filter((e) => (e.type === "dir" && /\.app$/i.test(e.path)) || (e.type === "file" && PKG.test(e.path))).map((e) => e.path).slice(0, 200))).catch(() => setCandidates([])); }, [connected, root]);
  const selected = useMemo(() => roots.find((r) => r.id === root), [roots, root]);

  const approve = async (p: string) => { try { const r = await addRoot(p); toast.success(`Approved ${r.label}`); await refresh(); setRoot(r.id); setPathInput(""); } catch (e) { toast.error((e as Error).message); } };
  const pick = async () => { const p = await pickFolderNative(); if (p) await approve(p); else if (!isDesktop()) toast.info("Type or paste the folder path instead."); };

  if (!connected) return (
    <Card className="border-dashed">
      <CardBody className="flex flex-wrap items-center gap-4">
        <div className="grid size-10 place-items-center rounded-xl bg-overlay text-muted"><Lock className="size-5" /></div>
        <div className="min-w-0 flex-1"><p className="text-sm font-medium">Local folders, installed apps and binaries</p><p className="text-[13px] text-muted">Analysing apps on your computer (macOS .app bundles, .asar, APK/JAR, Mach-O/ELF/PE, WASM) and REA deep analysis need the OmniForge desktop app. Browsers can't read your disk without a helper.</p></div>
        <Button variant="secondary" onClick={() => nav("/integrations")}>Set up desktop app</Button>
      </CardBody>
    </Card>
  );

  return (
    <Card>
      <CardHeader><CardTitle>On this computer</CardTitle><Badge tone="ok" dot>Desktop connected</Badge></CardHeader>
      <CardBody className="space-y-5">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-48 flex-1"><Select value={root} onValueChange={setRoot} options={roots.map((r) => ({ value: r.id, label: r.label, hint: r.writable ? "read/write" : "read-only" }))} placeholder={roots.length ? "Choose an approved folder" : "No folders approved yet"} /></div>
            {canApprove && <Button variant="secondary" icon={<FolderPlus className="size-4" />} onClick={pick}>{isDesktop() ? "Choose folder…" : "Approve"}</Button>}
            {selected && canApprove && <Button variant="ghost" size="icon" aria-label="Remove approval" title="Remove approval" onClick={async () => { await removeRoot(selected.id); await refresh(); }}><Trash2 className="size-4" /></Button>}
          </div>
          {canApprove && !isDesktop() && <div className="flex gap-2"><Input value={pathInput} onChange={(e) => setPathInput(e.target.value)} placeholder="/Users/you/Projects/my-app" aria-label="Folder path to approve" onKeyDown={(e) => { if (e.key === "Enter" && pathInput.trim()) void approve(pathInput.trim()); }} /><Button disabled={!pathInput.trim()} onClick={() => approve(pathInput.trim())}>Approve path</Button></div>}
          {!canApprove && <p className="text-xs text-muted">Folders are approved inside the desktop app (this paired session can only use folders already approved there).</p>}
          <p className="text-xs text-faint">OmniForge can only read folders you approve. Symlinks that escape them are blocked and <code>.env</code> values are masked.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 rounded-xl border border-line p-3">
            <div className="flex items-center gap-2 text-sm font-medium"><FolderOpen className="size-4 text-accent" />Analyse the whole folder</div>
            <p className="text-xs text-muted">Source tree analysis: frameworks, routes, components, dependencies, features and findings — fully local.</p>
            <Button variant="primary" disabled={!selected} icon={<ScanSearch className="size-4" />} onClick={async () => { const id = await analyzeLocalFolder(selected!.id, selected!.label); nav(`/analyze?job=${id}`); }}>Analyse folder</Button>
          </div>
          <div className="space-y-2 rounded-xl border border-line p-3">
            <div className="flex items-center gap-2 text-sm font-medium"><AppWindow className="size-4 text-accent" />Inspect an app, package or binary</div>
            <Input list="pkg-candidates" value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder="Applications/Foo.app or dist/app.asar" aria-label="Path of package inside the approved folder" disabled={!selected} />
            <datalist id="pkg-candidates">{candidates.map((c) => <option key={c} value={c} />)}</datalist>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={!selected || !pkg} icon={<Microscope className="size-4" />} onClick={async () => { const r = await inspectLocalPackage(selected!.id, pkg, pkg.split("/").pop() || pkg); nav(`/analyze?job=${r.jobId}`); }}>Inspect</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
              <div className="min-w-44 flex-1"><Select value={op} onValueChange={setOp} options={(ops.length ? ops : [{ id: "inspect-artifact", label: "Package / resource inventory", kind: "static" as const, accepts: "" }]).map((o) => ({ value: o.id, label: o.label, hint: o.kind === "native-provider" ? "launches tool" : undefined }))} /></div>
              <Button variant="soft" disabled={!selected || !pkg || !reaOk} title={reaOk ? "Run REA (reverse-engineering agent)" : "REA isn't installed — set it up in Integrations"} onClick={async () => { const o = ops.find((x) => x.id === op); if (!o) return; if (o.kind === "native-provider" && !window.confirm(`${o.label} launches a native analysis tool (Hopper/Ghidra/IDA) on your machine. Continue?`)) return; const id = await runRea(selected!.id, pkg, o, pkg.split("/").pop() || pkg, o.kind === "native-provider"); nav(`/analyze?job=${id}`); }}>Run REA</Button>
            </div>
            {!reaOk && <p className="text-xs text-warn">REA isn't installed. <button className="underline" onClick={() => nav("/integrations")}>Install it</button> (you approve every step).</p>}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
