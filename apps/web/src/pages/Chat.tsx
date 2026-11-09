import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Bot, CheckCircle2, CircleAlert, Loader2, MessageSquarePlus, Network, Paperclip, Send, StopCircle, Trash2, User, Workflow, X } from "lucide-react";
import { modelKey, runOrchestrator, singleChatRequest, uid, type ChatMessage, type Conversation, type ModelInfo, type OrchestratorEvent } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { loadProviders } from "@/lib/ai";
import { collectFiles, type PickedFile } from "@/lib/analyze";
import { chatHost } from "@/lib/chatHost";
import { cn } from "@/lib/utils";
import { useAuthorization } from "@/components/domain/Omnibox";
import { Badge, Button, Card, EmptyState, SectionTitle, Segmented, Textarea } from "@/components/ui/primitives";
import { Select } from "@/components/ui/overlay";
import { Markdown } from "@/components/ui/Markdown";

type Mode = "single" | "orchestrator";
type Step = { kind: "tool" | "subagent"; id: string; label: string; agent?: string; status: "running" | "ok" | "failed"; detail?: string };
type Msg = ChatMessage & { trace?: Step[]; mode?: Mode };
type Chat = Omit<Conversation, "messages"> & { messages: Msg[]; mode?: Mode };

const PREFIX = "aichat:";
const TEXT_EXT = /\.(?:[cm]?[jt]sx?|json|md|txt|html?|css|scss|py|go|rs|java|kt|swift|rb|php|cs|c|h|cpp|hpp|sh|ya?ml|toml|xml|sql|graphql|gql|proto|env\.example|ini|cfg|csv|vue|svelte|astro)$/i;
const SUGGEST: Record<Mode, string[]> = {
  orchestrator: ["Analyse https://example.com and list its features with evidence", "Analyse github.com/vercel/next.js-examples… and explain the architecture", "Compare my two latest investigations using subagents", "Rebuild the checkout flow of my latest investigation in Next.js"],
  single: ["Explain how OAuth PKCE works", "Review the attached file for bugs", "Draft a data model for a booking app"],
};

function Trace({ steps, open }: { steps: Step[]; open?: boolean }) {
  if (!steps.length) return null;
  const done = steps.filter((s) => s.status !== "running").length;
  return (
    <details open={open} className="rounded-lg border border-line bg-bg/60 text-[12px]" data-testid="chat-trace">
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-muted">{steps.filter((s) => s.kind === "subagent").length ? "Agents & tools" : "Tools"} · {done}/{steps.length} steps</summary>
      <ul className="space-y-1 border-t border-line px-2.5 py-2">
        {steps.map((s) => <li key={`${s.agent ?? "main"}:${s.id}`} className={cn("flex items-start gap-1.5", s.agent && "pl-4")}>
          {s.status === "running" ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-accent" aria-label="running" /> : s.status === "ok" ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" aria-label="done" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-label="failed" />}
          <span className="min-w-0 break-words"><span className="font-medium text-fg">{s.kind === "subagent" && <Workflow className="mr-1 inline size-3 align-[-1px]" />}{s.label}</span>{s.detail && <span className="text-muted"> — {s.detail}</span>}</span>
        </li>)}
      </ul>
    </details>
  );
}

export default function ChatPage() {
  const { project, mutate, models, settings } = useApp();
  const nav = useNavigate();
  const { guard, dialog } = useAuthorization();
  const chats = useMemo(() => ((project?.conversations ?? []) as Chat[]).filter((c) => c.id.startsWith(PREFIX)).reverse(), [project?.conversations]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // activeId of a chat not saved yet = a fresh conversation; otherwise show the chosen (or latest) one
  const isNew = activeId !== null && !chats.some((c) => c.id === activeId);
  const active = isNew ? undefined : chats.find((c) => c.id === activeId) ?? chats[0];
  const shown = active?.messages ?? [];
  const [mode, setMode] = useState<Mode>("orchestrator");
  const [modelId, setModelId] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [live, setLive] = useState<{ text: string; steps: Step[] } | null>(null);
  const abort = useRef<AbortController | null>(null); const end = useRef<HTMLDivElement>(null); const fileRef = useRef<HTMLInputElement>(null);

  const usable = useMemo(() => models.filter((m) => m.capabilities.includes("chat") && (!settings.localOnly || m.local) && (mode === "single" || (m.capabilities.includes("tools") && !m.provider.startsWith("cli:")))), [models, settings.localOnly, mode]);
  useEffect(() => { if (!usable.some((m) => modelKey(m) === modelId)) setModelId(usable[0] ? modelKey(usable[0]) : ""); }, [usable, modelId]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [active?.messages.length, live?.text, live?.steps.length]);
  useEffect(() => { if (active?.mode) setMode(active.mode); }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (id: string, f: (c: Chat) => Chat, title?: string) => mutate((p) => {
    const list = p.conversations as Chat[];
    return { ...p, conversations: list.some((c) => c.id === id) ? list.map((c) => (c.id === id ? f(c) : c)) : [...list, f({ id, title: title ?? "New chat", messages: [], mode })] };
  });
  const newChat = () => { setActiveId(`${PREFIX}${uid("c")}`); setFiles([]); setLive(null); };
  const del = (id: string) => { mutate((p) => ({ ...p, conversations: p.conversations.filter((c) => c.id !== id) })); if (active?.id === id) setActiveId(null); };
  const attach = (picked: PickedFile[]) => setFiles((f) => [...f, ...picked].slice(0, 2_000));

  const send = async (raw: string) => {
    const q = raw.trim(); const model = usable.find((m) => modelKey(m) === modelId) as ModelInfo | undefined;
    if (!q || live || !model) return;
    const id = isNew ? activeId! : active?.id ?? `${PREFIX}${uid("c")}`; setActiveId(id);
    const history = (chats.find((c) => c.id === id)?.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    const attachedNote = files.length ? `\n\n📎 ${files.length === 1 ? files[0]!.path : `${files.length} files`}` : "";
    save(id, (c) => ({ ...c, mode, messages: [...c.messages, { id: uid("m"), role: "user", content: q + attachedNote, at: new Date().toISOString() }] }), q.slice(0, 60));
    setText(""); setLive({ text: "", steps: [] });
    const ctrl = new AbortController(); abort.current = ctrl; let steps: Step[] = []; let acc = "";
    const upd = (f: (s: Step[]) => Step[]) => { steps = f(steps); setLive({ text: acc, steps }); };
    try {
      const { providers } = await loadProviders(); const provider = providers.find((p) => p.id === model.provider);
      if (!provider) throw new Error(`${model.provider} isn't available (is it enabled and unlocked?)`);
      let answer: string;
      if (mode === "orchestrator") {
        const onEvent = (e: OrchestratorEvent) => {
          if (e.type === "text") { acc = e.text; setLive({ text: acc, steps }); }
          else if (e.type === "tool") upd((s) => [...s, { kind: "tool", id: e.id, agent: e.agent, label: `${e.agent ? `${e.agent} · ` : ""}${e.name}`, status: "running", detail: JSON.stringify(e.args).slice(0, 120) }]);
          else if (e.type === "tool_result") upd((s) => s.map((x) => (x.id === e.id && x.agent === e.agent && x.kind === "tool" ? { ...x, status: e.ok ? "ok" : "failed", detail: e.summary || x.detail } : x)));
          else if (e.type === "subagent") upd((s) => s.some((x) => x.kind === "subagent" && x.id === e.id) ? s.map((x) => (x.kind === "subagent" && x.id === e.id ? { ...x, status: e.status === "running" ? "running" : e.status === "done" ? "ok" : "failed" } : x)) : [...s, { kind: "subagent", id: e.id, label: `${e.id} · ${e.role}`, status: "running", detail: e.objective.slice(0, 140) }]);
        };
        const r = await runOrchestrator({ provider, model, history, message: q, host: chatHost(files), onEvent, signal: ctrl.signal });
        answer = r.text;
        if (r.investigations.length) answer += `\n\nInvestigations used: ${r.investigations.join(", ")}`;
      } else {
        const texts: { name: string; text: string }[] = []; let budget = 400_000;
        for (const f of files) { if (!TEXT_EXT.test(f.path) || f.file.size > 200_000 || f.file.size > budget) continue; texts.push({ name: f.path, text: await f.file.text() }); budget -= f.file.size; }
        const req = singleChatRequest({ model: model.id, history, message: q, attachments: texts });
        for await (const e of provider.chat({ ...req, signal: ctrl.signal, maxTokens: Math.min(model.maxOutput ?? 8192, 16_384) })) if (e.type === "text") { acc += e.text; setLive({ text: acc, steps }); }
        answer = acc + (files.length > texts.length ? `\n\n_(${files.length - texts.length} attached file(s) were not text or too large to include; switch to Orchestrator to analyse them)_` : "");
      }
      save(id, (c) => ({ ...c, messages: [...c.messages, { id: uid("m"), role: "assistant", content: answer || "(no answer)", model: `${model.provider}/${model.id}`, at: new Date().toISOString(), trace: steps, mode }] }));
      setFiles([]);
    } catch (e) {
      const stopped = (e as Error).name === "AbortError";
      if (!stopped) toast.error((e as Error).message);
      save(id, (c) => ({ ...c, messages: [...c.messages, { id: uid("m"), role: "assistant", content: `${acc}${acc ? "\n\n" : ""}_(${stopped ? "stopped" : `error: ${(e as Error).message}`})_`, model: `${model.provider}/${model.id}`, at: new Date().toISOString(), trace: steps.map((s) => (s.status === "running" ? { ...s, status: "failed" as const } : s)), mode }] }));
    } finally { setLive(null); abort.current = null; }
  };
  const submit = (q: string) => (mode === "orchestrator" ? guard(() => void send(q)) : void send(q));

  const noModels = !models.length;
  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
      {dialog}
      <SectionTitle title="AI Chat" sub="Talk to one model, or to an orchestrator that analyses sites, repos and files, hands work to parallel subagents and can rebuild what it finds — with every rebuild approved by you." />
      {noModels ? <Card><EmptyState icon={<Bot className="size-5" />} title="Connect a model to start chatting" body={settings.localOnly ? "Local-only mode is on: start Ollama/LM Studio (desktop app) or switch privacy mode in Settings." : "Add any provider — OpenRouter, Anthropic, OpenAI, Gemini, a local model — in AI Studio."} action={<Button variant="primary" onClick={() => nav("/studio?tab=providers")}>Add a provider</Button>} /></Card> : (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[14rem_1fr]">
          <Card className="hidden min-h-0 flex-col lg:flex" aria-label="Conversations">
            <div className="border-b border-line p-2"><Button className="w-full" size="sm" icon={<MessageSquarePlus className="size-4" />} onClick={newChat}>New chat</Button></div>
            <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
              {chats.map((c) => <li key={c.id} className="group flex items-center gap-1"><button onClick={() => setActiveId(c.id)} className={cn("min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-[13px]", c.id === active?.id ? "bg-overlay text-fg" : "text-muted hover:text-fg")}>{c.mode === "orchestrator" ? <Network className="mr-1.5 inline size-3.5 align-[-2px]" /> : <Bot className="mr-1.5 inline size-3.5 align-[-2px]" />}{c.title}</button><Button size="icon-sm" variant="ghost" aria-label={`Delete chat ${c.title}`} className="opacity-60 group-hover:opacity-100" onClick={() => del(c.id)}><Trash2 className="size-3.5" /></Button></li>)}
              {!chats.length && <li className="px-2 py-3 text-xs text-faint">Conversations are saved in this project.</li>}
            </ul>
          </Card>
          <Card className="flex h-[72dvh] min-h-[30rem] flex-col lg:h-auto" onDragOver={(e) => e.preventDefault()} onDrop={async (e) => { e.preventDefault(); attach(await collectFiles(e.dataTransfer.items.length ? e.dataTransfer.items : e.dataTransfer.files)); }}>
            <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
              <div role="group" aria-label="Chat mode"><Segmented size="sm" value={mode} onChange={(v) => setMode(v)} options={[{ value: "single", label: "Single model", title: "Plain conversation with one model" }, { value: "orchestrator", label: "Orchestrator", title: "Tools + subagents: analyse, compare, rebuild" }]} /></div>
              <div className="w-full min-w-48 flex-1 sm:w-auto"><Select label="Model" value={modelId} onValueChange={setModelId} options={usable.map((m) => ({ value: modelKey(m), label: m.name ?? m.id, hint: m.local ? "local" : m.provider.replace(/^cli:/, "") }))} placeholder={mode === "orchestrator" ? "No tool-calling model connected" : "No chat model"} /></div>
              <Button size="sm" variant="ghost" className="lg:hidden" icon={<MessageSquarePlus className="size-4" />} onClick={newChat}>New</Button>
            </div>
            {mode === "orchestrator" && !usable.length && <p role="status" className="border-b border-line bg-warn/10 px-3 py-2 text-[13px] text-warn">The orchestrator needs a model that supports tool calling (most current Anthropic, OpenAI, Gemini, OpenRouter and many local models). Use Single model, or connect one in AI Studio.</p>}
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite" data-testid="chat-log">
              {!shown.length && !live && <div className="grid h-full place-items-center text-center"><div className="max-w-md space-y-3">{mode === "orchestrator" ? <Network className="mx-auto size-6 text-accent" /> : <Bot className="mx-auto size-6 text-accent" />}<p className="text-sm text-muted">{mode === "orchestrator" ? "Paste a website or GitHub link, or attach files — the orchestrator analyses them, delegates to subagents and answers from the evidence." : "Chat with any connected model. Attached text files are included as context."}</p><div className="flex flex-col gap-2">{SUGGEST[mode].map((s) => <button key={s} onClick={() => setText(s)} className="rounded-lg border border-line px-3 py-2 text-left text-[13px] text-muted transition hover:border-accent/50 hover:text-fg">{s}</button>)}</div></div></div>}
              {shown.map((m) => <div key={m.id} className={cn("flex gap-3", m.role === "user" && "flex-row-reverse")}>
                <div className={cn("grid size-7 shrink-0 place-items-center rounded-full", m.role === "user" ? "bg-overlay" : "bg-accent-soft text-accent")}>{m.role === "user" ? <User className="size-4" /> : m.mode === "orchestrator" ? <Network className="size-4" /> : <Bot className="size-4" />}</div>
                <div className={cn("min-w-0 max-w-[85%] space-y-2 rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed", m.role === "user" ? "bg-accent text-accent-fg" : "border border-line bg-bg")}>
                  {m.trace && <Trace steps={m.trace} />}
                  <div><Markdown text={m.content} /></div>
                  {m.model && <div className="border-t border-line pt-1 text-[11px] text-faint">AI-generated · {m.model}</div>}
                </div>
              </div>)}
              {live && <div className="flex gap-3"><div className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">{mode === "orchestrator" ? <Network className="size-4" /> : <Bot className="size-4" />}</div><div className="min-w-0 max-w-[85%] space-y-2 rounded-2xl border border-line bg-bg px-3.5 py-2.5 text-sm leading-relaxed"><Trace steps={live.steps} open />{live.text ? <Markdown text={live.text} /> : <span className="text-faint">{live.steps.length ? "Working…" : "Thinking…"}</span>}</div></div>}
              <div ref={end} />
            </div>
            {files.length > 0 && <div className="flex flex-wrap gap-1.5 border-t border-line px-3 pt-2" aria-label="Attached files">{files.slice(0, 6).map((f, i) => <Badge key={`${f.path}${i}`}>{f.path}</Badge>)}{files.length > 6 && <Badge>+{files.length - 6} more</Badge>}<Button size="xs" variant="ghost" icon={<X className="size-3" />} onClick={() => setFiles([])}>Remove</Button></div>}
            <form className="flex items-end gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
              <input ref={fileRef} type="file" multiple hidden aria-label="Attach files" onChange={async (e) => { if (e.target.files) attach(await collectFiles(e.target.files)); e.target.value = ""; }} />
              <Button type="button" size="icon" variant="ghost" aria-label="Attach files" title="Attach files (or drop them here)" onClick={() => fileRef.current?.click()}><Paperclip className="size-4" /></Button>
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} className="min-h-11 flex-1 resize-none text-base sm:text-sm" placeholder={mode === "orchestrator" ? "Ask, or paste a URL / GitHub repo to analyse…" : "Message…"} aria-label="Message" onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(text); } }} />
              {live ? <Button type="button" variant="danger" size="icon" aria-label="Stop" onClick={() => abort.current?.abort()}><StopCircle className="size-4" /></Button> : <Button type="submit" variant="primary" size="icon" aria-label="Send" disabled={!text.trim() || !modelId}><Send className="size-4" /></Button>}
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
