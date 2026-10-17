import { lazy, Suspense, useEffect } from "react";
import { HashRouter, Route, Routes, useNavigate } from "react-router";
import { initDesktop } from "@/lib/desktop";
import { Toaster } from "sonner";
import { useApp } from "@/lib/store";
import { refreshModels } from "@/lib/ai";
import { Shell } from "@/components/layout/Shell";
import { Spinner } from "@/components/ui/primitives";

const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Analyze = lazy(() => import("@/pages/Analyze"));
const RepoRip = lazy(() => import("@/pages/RepoRip"));
const Investigations = lazy(() => import("@/pages/Investigations"));
const InvestigationDetail = lazy(() => import("@/pages/InvestigationDetail"));
const Applications = lazy(() => import("@/pages/Applications"));
const FeatureLibrary = lazy(() => import("@/pages/FeatureLibrary"));
const AIStudio = lazy(() => import("@/pages/AIStudio"));
const Workspace = lazy(() => import("@/pages/Workspace"));
const LocalModels = lazy(() => import("@/pages/LocalModels"));
const Integrations = lazy(() => import("@/pages/Integrations"));
const Deployments = lazy(() => import("@/pages/Deployments"));
const Settings = lazy(() => import("@/pages/Settings"));

function DesktopBridge() { const nav = useNavigate(); useEffect(() => { let un: (() => void) | undefined; void initDesktop(nav).then((u) => (un = u)); return () => un?.(); }, [nav]); return null; }

export default function App() {
  const init = useApp((s) => s.init);
  const theme = useApp((s) => s.settings.theme);
  const bridgeState = useApp((s) => s.bridgeState);
  const providers = useApp((s) => s.providers);
  const ready = useApp((s) => s.ready);
  useEffect(() => { void init(); }, [init]);
  useEffect(() => { if (ready) void refreshModels(); }, [ready, providers, bridgeState]);
  return (
    <HashRouter>
      <DesktopBridge />
      <Suspense fallback={<div className="grid h-dvh place-items-center"><Spinner className="size-6" /></div>}>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Dashboard />} />
            <Route path="analyze" element={<Analyze />} />
            <Route path="repo-rip" element={<RepoRip />} />
            <Route path="investigations" element={<Investigations />} />
            <Route path="investigations/:id" element={<InvestigationDetail />} />
            <Route path="applications" element={<Applications />} />
            <Route path="features" element={<FeatureLibrary />} />
            <Route path="studio" element={<AIStudio />} />
            <Route path="workspace" element={<Workspace />} />
            <Route path="models" element={<LocalModels />} />
            <Route path="integrations" element={<Integrations />} />
            <Route path="deployments" element={<Deployments />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Dashboard />} />
          </Route>
        </Routes>
      </Suspense>
      <Toaster theme={theme} position="bottom-right" richColors closeButton toastOptions={{ classNames: { toast: "!rounded-xl !border-line !bg-elevated !text-fg" } }} />
    </HashRouter>
  );
}
