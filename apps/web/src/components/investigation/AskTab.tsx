import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Bot, Send, Sparkles, StopCircle, User } from "lucide-react";
import { toast } from "sonner";
import { SECURITY_PREAMBLE, siteBrief, uid, untrusted, type ChatMessage, type Investigation } from "@omniforge/core";
import { useApp } from "@/lib/store";
import { ask, pickModel } from "@/lib/ai";
import { cn } from "@/lib/utils";
import { Badge, Button, Card, CardBody, EmptyState, Textarea } from "@/components/ui/primitives";
import { useEvidence } from "./EvidenceLink";

const QUICK = ["Summarise this app's architecture in plain English.", "Which features would be hardest to rebuild, and why?", "What are the biggest risks or quality problems?", "Draft a step-by-step plan to re-create this in a modern stack."];

function Cited({ text }: { text: string }) {
  const { byId, open } = useEvidence();
  const parts = text.split(/(\bev_[a-z0-9]{4,}\b)/gi);
  return <>{parts.map((p, i) => (byId.has(p) ? <button key={i} onClick={() => open(p)} className="mx-0.5 rounded border border-accent/30 bg-accent-soft px-1 text-[11px] font-medium text-accent hover:underline">{byId.get(p)!.kind}</button> : <span key={i}>{p}</span>))}</>;
}

export function AskTab({ inv }: { inv: Investigation }) {
  const { project, mutate, models, saveInvestigation, settings } = useApp();
  const nav = useNavigate();
  const convId = `inv:${inv.id}`;
  const convo = project?.conversations.find((c) => c.id === convId);
  const msgs: ChatMessage[] = convo?.messages ?? [];
  const [text, setText] = useState(""); const [streaming, setStreaming] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null); const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs.length, streaming]);
  const pick = pickModel("research");
  const push = (m: ChatMessage) => mutate((p) => ({ ...p, conversations: p.conversations.some((c) => c.id === convId) ? p.conversations.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, m] } : c)) : [...p.conversations, { id: convId, title: `Q&A · ${inv.name}`, agent: "investigator", messages: [m] }] }));

  const send = async (q: string) => {
    q = q.trim(); if (!q || busy) return;
    setText(""); setBusy(true); setStreaming(""); push({ id: uid("m"), role: "user", content: q, at: new Date().toISOString() });
    const ctrl = new AbortController(); abort.current = ctrl;
    const evList = inv.evidence.slice(0, 120).map((e) => `${e.id} [${e.kind}] ${e.summary}`).join("\n");
    const history = msgs.slice(-6).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
    try {
      const r = await ask("research", `${siteBrief(inv)}\n\n${untrusted("evidence-ledger", evList, 20_000)}\n\n${history ? `Earlier conversation:\n${history}\n\n` : ""}Question: ${q}`, {
        system: `${SECURITY_PREAMBLE}\n\nYou are the OmniForge investigator. Answer ONLY from the analysis provided. Cite supporting evidence ids (like ev_abc123) inline. Separate what was observed/recovered from what you infer, and say plainly when the evidence doesn't answer the question. Be concise.`,
        signal: ctrl.signal, onText: setStreaming,
      });
      push({ id: uid("m"), role: "assistant", content: r.text, model: `${r.model.provider}/${r.model.id}`, at: new Date().toISOString() });
    } catch (e) { if ((e as Error).name !== "AbortError") toast.error((e as Error).message); }
    finally { setStreaming(null); setBusy(false); abort.current = null; }
  };
  const saveSummary = (content: string) => { saveInvestigation({ ...inv, summary: content }); toast.success("Saved as the investigation summary (labelled AI-generated)"); };

  if (!models.length && !pick) return <Card><EmptyState icon={<Bot className="size-5" />} title="Connect a model to ask questions" body={settings.localOnly ? "Local-only mode is on: start Ollama/LM Studio (desktop app) or switch privacy mode in Settings." : "Add an AI provider (or a local model). Everything above works without one — only questions and rewrites need AI."} action={<Button variant="primary" onClick={() => nav("/studio")}>Open AI Studio</Button>} /></Card>;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
      <Card className="flex h-[66dvh] min-h-[28rem] flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
          {msgs.length === 0 && streaming === null && <div className="grid h-full place-items-center text-center"><div className="max-w-sm space-y-3"><Sparkles className="mx-auto size-6 text-accent" /><p className="text-sm text-muted">Ask anything about this investigation. Answers cite evidence you can click, and are always labelled AI-generated.</p><div className="flex flex-col gap-2">{QUICK.map((q) => <button key={q} onClick={() => void send(q)} className="rounded-lg border border-line px-3 py-2 text-left text-[13px] text-muted transition hover:border-accent/50 hover:text-fg">{q}</button>)}</div></div></div>}
          {msgs.map((m) => <div key={m.id} className={cn("flex gap-3", m.role === "user" && "flex-row-reverse")}><div className={cn("grid size-7 shrink-0 place-items-center rounded-full", m.role === "user" ? "bg-overlay" : "bg-accent-soft text-accent")}>{m.role === "user" ? <User className="size-4" /> : <Bot className="size-4" />}</div><div className={cn("max-w-[85%] space-y-1.5 rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed", m.role === "user" ? "bg-accent text-accent-fg" : "border border-line bg-bg")}><div className="whitespace-pre-wrap break-words"><Cited text={m.content} /></div>{m.role === "assistant" && <div className="flex items-center justify-between gap-2 border-t border-line pt-1.5 text-[11px] text-faint"><span>AI-generated · {m.model}</span><button className="text-accent hover:underline" onClick={() => saveSummary(m.content)}>Save as summary</button></div>}</div></div>)}
          {streaming !== null && <div className="flex gap-3"><div className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"><Bot className="size-4" /></div><div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl border border-line bg-bg px-3.5 py-2.5 text-sm leading-relaxed">{streaming || <span className="text-faint">Thinking…</span>}</div></div>}
          <div ref={end} />
        </div>
        <form className="flex items-end gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} className="min-h-10 flex-1 resize-none" placeholder="Ask about pages, features, risks, how to rebuild…" aria-label="Question" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }} />
          {busy ? <Button type="button" variant="danger" size="icon" aria-label="Stop" onClick={() => abort.current?.abort()}><StopCircle className="size-4" /></Button> : <Button type="submit" variant="primary" size="icon" aria-label="Send" disabled={!text.trim()}><Send className="size-4" /></Button>}
        </form>
      </Card>
      <Card className="h-fit"><CardBody className="space-y-3 text-[13px]"><div className="font-medium">Model</div>{pick ? <><p className="break-words text-muted">{pick.model.name ?? pick.model.id}</p><div className="flex flex-wrap gap-1.5"><Badge>{pick.model.provider.replace(/^cli:/, "")}</Badge>{pick.model.local && <Badge tone="ok">local</Badge>}</div><p className="text-xs text-faint">{pick.reasons[0]}</p></> : <p className="text-muted">None available</p>}<p className="border-t border-line pt-3 text-xs text-faint">The analysis is sent to the model as fenced, untrusted data. Instructions hidden in analysed pages are ignored.{settings.localOnly ? " Local-only mode: only local models are used." : ""}</p></CardBody></Card>
    </div>
  );
}
