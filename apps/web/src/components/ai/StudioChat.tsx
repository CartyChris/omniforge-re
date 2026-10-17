import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Bot, Eraser, Send, StopCircle, User } from "lucide-react";
import { ROLES, SECURITY_PREAMBLE, modelKey, uid, type AgentRole, type ChatMessage } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { loadProviders, pickModel } from "@/lib/ai";
import { cn } from "@/lib/utils";
import { Button, Card, EmptyState, Textarea } from "@/components/ui/primitives";
import { Select } from "@/components/ui/overlay";

const CONV = "chat:main";

export function ChatPanel() {
  const { project, mutate, models, settings } = useApp();
  const msgs: ChatMessage[] = project?.conversations.find((c) => c.id === CONV)?.messages ?? [];
  const [modelId, setModelId] = useState(""); const [role, setRole] = useState<AgentRole | "general">("general"); const [text, setText] = useState(""); const [stream, setStream] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [withFiles, setWithFiles] = useState(false);
  const abort = useRef<AbortController | null>(null); const end = useRef<HTMLDivElement>(null);
  const usable = useMemo(() => models.filter((m) => m.capabilities.includes("chat") && (!settings.localOnly || m.local)), [models, settings.localOnly]);
  useEffect(() => { if (!modelId || !usable.find((m) => modelKey(m) === modelId)) { const p = pickModel("summarize"); setModelId(p ? modelKey(p.model) : usable[0] ? modelKey(usable[0]) : ""); } }, [usable]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs.length, stream]);
  const push = (m: ChatMessage) => mutate((p) => ({ ...p, conversations: p.conversations.some((c) => c.id === CONV) ? p.conversations.map((c) => (c.id === CONV ? { ...c, messages: [...c.messages, m] } : c)) : [...p.conversations, { id: CONV, title: "AI Studio chat", messages: [m] }] }));

  const send = async () => {
    const q = text.trim(); const model = usable.find((m) => modelKey(m) === modelId); if (!q || busy || !model) return;
    setText(""); setBusy(true); setStream(""); push({ id: uid("m"), role: "user", content: q, at: new Date().toISOString() });
    const ctrl = new AbortController(); abort.current = ctrl; let acc = "";
    try {
      const { providers } = await loadProviders(); const prov = providers.find((p) => p.id === model.provider); if (!prov) throw new Error(`${model.provider} isn't available (is it enabled and unlocked?)`);
      const files = withFiles ? `\n\nProject files:\n${Object.keys(project?.workspace.files ?? {}).slice(0, 200).join("\n")}` : "";
      const system = `${SECURITY_PREAMBLE}\n\n${role === "general" ? "You are a helpful engineering assistant inside OmniForge RE." : ROLES[role].system}${files}`;
      const history = msgs.slice(-12).map((m) => ({ role: m.role === "assistant" ? "assistant" as const : "user" as const, content: m.content }));
      for await (const e of prov.chat({ model: model.id, system, messages: [...history, { role: "user", content: q }], signal: ctrl.signal, maxTokens: 4096 })) { if (e.type === "text") { acc += e.text; setStream(acc); } }
      push({ id: uid("m"), role: "assistant", content: acc, model: `${model.provider}/${model.id}`, at: new Date().toISOString() });
    } catch (e) { if ((e as Error).name !== "AbortError") toast.error((e as Error).message); else if (acc) push({ id: uid("m"), role: "assistant", content: acc + "\n\n_(stopped)_", model: model.id, at: new Date().toISOString() }); }
    finally { setStream(null); setBusy(false); abort.current = null; }
  };

  if (!usable.length) return <Card><EmptyState icon={<Bot className="size-5" />} title="No chat model available" body={settings.localOnly ? "Local-only mode is on: start a local runtime or turn the mode off in Settings." : "Add a provider in the Providers tab."} /></Card>;
  return (
    <Card className="flex h-[70dvh] min-h-[30rem] flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
        <div className="w-full min-w-48 flex-1 sm:w-auto"><Select value={modelId} onValueChange={setModelId} options={usable.map((m) => ({ value: modelKey(m), label: m.name ?? m.id, hint: m.local ? "local" : m.provider.replace(/^cli:/, "") }))} /></div>
        <div className="w-44"><Select value={role} onValueChange={(v) => setRole(v as AgentRole | "general")} options={[{ value: "general", label: "General assistant" }, ...Object.entries(ROLES).map(([k, r]) => ({ value: k, label: r.label }))]} /></div>
        <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />project file list</label>
        <Button size="icon-sm" variant="ghost" aria-label="Clear conversation" title="Clear conversation" disabled={!msgs.length} onClick={() => mutate((p) => ({ ...p, conversations: p.conversations.filter((c) => c.id !== CONV) }))}><Eraser className="size-4" /></Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        {msgs.length === 0 && stream === null && <div className="grid h-full place-items-center text-center text-sm text-muted"><div className="max-w-sm space-y-2"><Bot className="mx-auto size-6 text-accent" /><p>Chat with any connected model. Pick an agent role to give it that role's rules and expertise.</p><p className="text-xs text-faint">Pasted code and files are sent only to the provider you picked{settings.localOnly ? " (local-only mode: local models only)" : ""}.</p></div></div>}
        {msgs.map((m) => <div key={m.id} className={cn("flex gap-3", m.role === "user" && "flex-row-reverse")}><div className={cn("grid size-7 shrink-0 place-items-center rounded-full", m.role === "user" ? "bg-overlay" : "bg-accent-soft text-accent")}>{m.role === "user" ? <User className="size-4" /> : <Bot className="size-4" />}</div><div className={cn("max-w-[85%] space-y-1.5 rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed", m.role === "user" ? "bg-accent text-accent-fg" : "border border-line bg-bg")}><div className="whitespace-pre-wrap break-words">{m.content}</div>{m.model && <div className="border-t border-line pt-1 text-[11px] text-faint">{m.model}</div>}</div></div>)}
        {stream !== null && <div className="flex gap-3"><div className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"><Bot className="size-4" /></div><div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl border border-line bg-bg px-3.5 py-2.5 text-sm leading-relaxed">{stream || <span className="text-faint">Thinking…</span>}</div></div>}
        <div ref={end} />
      </div>
      <form className="flex items-end gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} className="min-h-10 flex-1 resize-none" placeholder="Message…" aria-label="Message" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        {busy ? <Button type="button" variant="danger" size="icon" aria-label="Stop" onClick={() => abort.current?.abort()}><StopCircle className="size-4" /></Button> : <Button type="submit" variant="primary" size="icon" aria-label="Send" disabled={!text.trim()}><Send className="size-4" /></Button>}
      </form>
    </Card>
  );
}
