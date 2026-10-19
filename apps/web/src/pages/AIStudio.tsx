import { useSearchParams } from "react-router";
import { SectionTitle } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlay";
import { BuildPanel } from "@/components/ai/StudioBuild";
import { ChatPanel } from "@/components/ai/StudioChat";
import { CliAgentPanel } from "@/components/ai/CliAgent";
import { SkillsPanel } from "@/components/ai/SkillsPanel";
import { AgentsPanel, ModelsPanel, ProvidersPanel, RoutingPanel } from "@/components/ai/StudioProviders";
import { useApp } from "@/lib/store";

export default function AIStudio() {
  const [params, setParams] = useSearchParams(); const nModels = useApp((s) => s.models.length);
  const tab = params.get("tab"); const value = tab === "rebuild" || tab === "extract" || !tab ? "build" : tab;
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <SectionTitle title="AI Studio" sub="Plan, build and verify with AI agents — any provider, cloud or local. You review every plan, can skip or edit any task, and approve every command." />
      <Tabs value={value} onValueChange={(v) => { const n = new URLSearchParams(params); n.set("tab", v); setParams(n, { replace: true }); }}>
        <TabsList><TabsTrigger value="build">Build</TabsTrigger><TabsTrigger value="chat">Chat</TabsTrigger><TabsTrigger value="cli">Agent CLI</TabsTrigger><TabsTrigger value="skills">Skills</TabsTrigger><TabsTrigger value="providers">Providers</TabsTrigger><TabsTrigger value="models">Models{nModels ? ` (${nModels})` : ""}</TabsTrigger><TabsTrigger value="routing">Routing</TabsTrigger><TabsTrigger value="agents">Agents</TabsTrigger></TabsList>
        <div className="pt-5">
          <TabsContent value="build"><BuildPanel /></TabsContent>
          <TabsContent value="chat"><ChatPanel /></TabsContent>
          <TabsContent value="cli"><CliAgentPanel /></TabsContent>
          <TabsContent value="skills"><SkillsPanel /></TabsContent>
          <TabsContent value="providers"><ProvidersPanel /></TabsContent>
          <TabsContent value="models"><ModelsPanel /></TabsContent>
          <TabsContent value="routing"><RoutingPanel /></TabsContent>
          <TabsContent value="agents"><AgentsPanel /></TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
