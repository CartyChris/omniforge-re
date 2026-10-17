/**
 * A WorkspaceFS backed by an approved local folder (desktop). Agent tools are synchronous, so the folder's text files are
 * cached up front; writes/deletes are queued and flushed to the bridge (always before a command runs, and at the end).
 */
import type { CommandRunner, WorkspaceFS } from "@omniforge/core";
import { useApp } from "./store";
import { readSSE } from "./bridge";
import { listTree } from "./local";

export interface LocalWorkspace { rootId: string; fs: WorkspaceFS & { flush(): Promise<void>; pending(): number; readonly: Set<string> }; runner: CommandRunner; skipped: string[] }

const MAX_FILES = 800, MAX_BYTES = 400_000;

export async function openLocalWorkspace(rootId: string, onProgress?: (n: number, total: number) => void): Promise<LocalWorkspace> {
  const bridge = useApp.getState().bridge; if (!bridge) throw new Error("This needs the OmniForge desktop app.");
  const { entries } = await listTree(rootId);
  const files = entries.filter((e) => e.type === "file");
  const take = files.filter((e) => (e.size ?? 0) <= MAX_BYTES && !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|mp[34]|mov|wasm|dylib|so|bin|dmg|app)$/i.test(e.path)).slice(0, MAX_FILES);
  const skipped = files.filter((e) => !take.includes(e)).map((e) => e.path);
  const cache = new Map<string, string>(); const readonly = new Set<string>();
  let done = 0;
  for (let i = 0; i < take.length; i += 8) {
    await Promise.all(take.slice(i, i + 8).map(async (e) => {
      try { const r = await bridge.get<{ content: string; masked: boolean }>(`/bridge/fs/read?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(e.path)}`); cache.set(e.path, r.content); if (r.masked) readonly.add(e.path); }
      catch { skipped.push(e.path); }
      onProgress?.(++done, take.length);
    }));
  }
  const writes = new Map<string, string>(); const deletes = new Set<string>();
  const fs: LocalWorkspace["fs"] = {
    read: (p) => cache.get(p),
    write: (p, c) => { if (readonly.has(p)) throw new Error(`${p} contains secrets and is read-only to agents`); cache.set(p, c); writes.set(p, c); deletes.delete(p); },
    remove: (p) => { if (readonly.has(p)) throw new Error(`${p} contains secrets and is read-only to agents`); cache.delete(p); writes.delete(p); deletes.add(p); },
    list: () => [...cache.keys()].sort(),
    pending: () => writes.size + deletes.size,
    readonly,
    async flush() {
      for (const [p, c] of [...writes]) { await bridge.post("/bridge/fs/write", { root: rootId, path: p, content: c }); writes.delete(p); }
      for (const p of [...deletes]) { await bridge.post("/bridge/fs/delete", { root: rootId, path: p }).catch(() => {}); deletes.delete(p); }
    },
  };
  const runner: CommandRunner = {
    async run(cmd, o) {
      await fs.flush();
      const meta = await bridge.post<{ id: string }>("/bridge/jobs", { root: rootId, shell: true, command: cmd, timeoutMs: o.timeoutMs });
      let out = ""; let code = 1;
      const res = await bridge.raw("GET", `/bridge/jobs/${meta.id}/stream`, undefined, o.signal);
      await readSSE(res, (ev, d) => { if (ev === "line") out += d.text + "\n"; else if (ev === "end") code = d.code ?? (d.state === "done" ? 0 : 1); });
      return { code, output: out };
    },
  };
  return { rootId, fs, runner, skipped };
}
