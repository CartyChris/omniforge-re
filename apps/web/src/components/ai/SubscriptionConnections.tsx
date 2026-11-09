import { useState } from "react";
import { toast } from "sonner";
import { useApp } from "@/lib/store";
import { Button, Card, CardBody } from "@/components/ui/primitives";

export function SubscriptionConnections() {
  const { bridge, bridgeState } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  async function login(id: string) {
    if (!bridge) return;
    setBusy(id);
    try {
      const result = await bridge.post<{ opened: boolean; command: string }>("/bridge/cli/login", { id });
      setMessage(result.opened ? "Finish authorization in the provider’s browser window, then rescan CLIs in Integrations. Opening sign-in does not confirm a connection." : `Automatic launch is unavailable on this host. Native sign-in command: ${result.command}`);
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(null); }
  }
  return <Card><CardBody className="space-y-3">
    <h3 className="text-sm font-semibold">Coding subscriptions</h3>
    <p className="text-sm text-muted">Connect through the installed CLI’s official browser sign-in. Credentials stay with that CLI on your Mac; subscription quota is separate from API billing.</p>
    <div className="flex flex-wrap gap-2">
      <Button className="min-h-11" disabled={bridgeState !== "connected" || busy !== null} onClick={() => void login("claude-code")}>Connect Claude Code</Button>
      <Button className="min-h-11" disabled={bridgeState !== "connected" || busy !== null} onClick={() => void login("codex")}>Connect Codex / ChatGPT</Button>
    </div>
    {bridgeState !== "connected" && <p className="text-sm text-muted">Requires the connected macOS desktop app and the corresponding CLI. Web-only subscription OAuth is not offered here.</p>}
    {message && <p role="status" className="break-words text-sm text-muted">{message}</p>}
    <p className="text-sm text-muted">Z.AI Coding Plan: choose Claude Code in Agent mode, enable the Coding Plan option, and enter your plan API key. Requests use Z.AI’s subscription endpoint through Claude Code, not the pay-as-you-go provider.</p>
    <a href="https://docs.z.ai/devpack/tool/claude" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm text-accent underline">Z.AI setup and supported-use policy</a>
  </CardBody></Card>;
}
