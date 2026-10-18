import { useEffect, useRef, useState } from "react";
import { Bot, Eraser, MessageSquareText, Sparkles, StopCircle, Wand2 } from "lucide-react";
import { EDIT_PRESETS, SECURITY_PREAMBLE, untrusted, type EditProposal } from "@omniforge/core";
import { ask, pickModel, proposeEdit } from "@/lib/ai";
import { audit } from "@/lib/audit";
import { useApp } from "@/lib/store";
import { Badge, Button, Textarea } from "@/components/ui/primitives";
import type { Marker } from "./Panels";

export interface Proposal extends EditProposal { path: string; original: string; instruction: string; model: string; local: boolean }

const PRESETS: { id: keyof typeof EDIT_PRESETS; label: string }[] = [{ id: "fix", label: "Fix problems" }, { id: "refactor", label: "Refactor" }, { id: "comment", label: "Add comments" }, { id: "types", label: "Add types" }];

/** Ask the model to edit or explain the open file. Edits are only PROPOSED here — the diff is shown in the editor and nothing is written until the user accepts. */
export function AIPanel({ path, content, markers, onPropose, pending, focusSignal }: { path?: string; content?: string; markers: Marker[]; onPropose: (p: Proposal) => void; pending: boolean; focusSignal: number }) {
  const { settings, models } = useApp();
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false); const [stream, setStream] = useState(""); const [answer, setAnswer] = useState<string | null>(null); const [failure, setFailure] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null); const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (focusSignal) box.current?.focus(); }, [focusSignal]);
  useEffect(() => { setAnswer(null); setFailure(null); }, [path]);
  const pick = pickModel("code"); void models; // re-render when the model list changes
  const mine = markers.filter((m) => m.path === path && m.severity !== "info");

  const run = async (instruction: string, kind: "edit" | "explain") => {
    if (!path || content === undefined || busy) return;
    setBusy(true); setStream(""); setAnswer(null); setFailure(null);
    const ctrl = new AbortController(); abort.current = ctrl;
    try {
      if (kind === "explain") {
        const r = await ask("code", `Explain what this file does and point out anything risky or surprising. Be concise.\n\nFile path: ${path}\n\n${untrusted(`file:${path}`, content, 60_000)}`, { system: `${SECURITY_PREAMBLE}\n\nYou are a senior engineer explaining code to a colleague.`, signal: ctrl.signal, onText: setStream });
        setAnswer(r.text);
      } else {
        const r = await proposeEdit({ path, content, instruction, problems: mine.map((m) => ({ line: m.line, severity: m.severity, message: m.message })) }, { signal: ctrl.signal, onText: setStream });
        if (!r.ok) setFailure(r.reason);
        else { onPropose({ ...r, path, original: content, instruction, model: `${r.model.provider}/${r.model.id}`, local: r.model.local }); void audit("ai edit proposed", `${path} via ${r.model.provider}/${r.model.id}${r.model.local ? " (local)" : ""}`); setText(""); }
      }
    } catch (e) { if ((e as Error).name !== "AbortError") setFailure((e as Error).message); }
    finally { setBusy(false); setStream(""); abort.current = null; }
  };

  const disabled = !path || content === undefined || !pick;
  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-xs text-muted"><Bot className="size-3.5" />{pick ? <>Using <span className="font-medium text-fg">{pick.model.name ?? pick.model.id}</span><Badge tone={pick.model.local ? "ok" : "neutral"}>{pick.model.local ? "local" : "cloud"}</Badge></> : <span className="text-warn">{settings.localOnly ? "Local-only mode: start a local model to use AI here." : "No model connected — add a provider in AI Studio."}</span>}</div>
        <p className="text-xs text-faint">{path ? <>Editing <span className="font-mono text-muted">{path}</span>. The file is sent to the model above; you review a diff before anything changes.</> : "Open a file to use AI on it."}</p>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick AI actions">
        {PRESETS.map((p) => <Button key={p.id} size="xs" variant="secondary" disabled={disabled || busy || pending || (p.id === "fix" && mine.length === 0)} title={p.id === "fix" && mine.length === 0 ? "No editor problems in this file" : EDIT_PRESETS[p.id]} onClick={() => void run(EDIT_PRESETS[p.id], "edit")}>{p.label}{p.id === "fix" && mine.length ? ` (${mine.length})` : ""}</Button>)}
        <Button size="xs" variant="secondary" icon={<MessageSquareText className="size-3.5" />} disabled={disabled || busy} onClick={() => void run("", "explain")}>Explain</Button>
      </div>
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void run(text, "edit"); }}>
        <Textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Describe the change" placeholder="Describe the change, e.g. “Make the form validate email addresses”" disabled={disabled || busy || pending} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) { e.preventDefault(); void run(text, "edit"); } }} />
        <div className="flex items-center gap-2">
          {busy ? <Button type="button" variant="danger" size="sm" icon={<StopCircle className="size-4" />} onClick={() => abort.current?.abort()}>Stop</Button> : <Button type="submit" variant="primary" size="sm" icon={<Wand2 className="size-4" />} disabled={disabled || pending || !text.trim()}>Propose edit</Button>}
          <span className="text-xs text-faint">⌘/Ctrl+Enter</span>
          {(answer || failure) && !busy && <Button type="button" size="icon-sm" variant="ghost" aria-label="Clear result" className="ml-auto" onClick={() => { setAnswer(null); setFailure(null); }}><Eraser className="size-4" /></Button>}
        </div>
        {pending && <p className="text-xs text-warn">Accept or reject the pending change first.</p>}
      </form>
      <div className="min-h-0 flex-1 overflow-auto" aria-live="polite">
        {busy && <div className="rounded-lg border border-line bg-bg p-3 text-xs text-muted"><div className="mb-1 flex items-center gap-1.5 font-medium"><Sparkles className="size-3.5 animate-pulse text-accent" />Working… {stream ? `${stream.length.toLocaleString()} characters so far` : "waiting for the model"}</div></div>}
        {failure && <div role="alert" className="rounded-lg border border-bad/30 bg-bad/10 p-3 text-[13px] text-bad">{failure}</div>}
        {answer && <div className="whitespace-pre-wrap break-words rounded-lg border border-line bg-bg p-3 text-[13px] leading-relaxed" data-testid="ai-answer">{answer}</div>}
      </div>
    </div>
  );
}
