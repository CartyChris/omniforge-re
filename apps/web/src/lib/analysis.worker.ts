/// <reference lib="webworker" />
import { investigateSource, readArchive, safeEntryPath, stripCommonRoot, detectArchive, type InputFile } from "@omniforge/core";

type In = { id: string; name: string; kind: "files" | "archive" | "folder"; origin: string; files: { path: string; data: ArrayBuffer; archive?: boolean }[] };

self.onmessage = async (e: MessageEvent<In>) => {
  const { id, name, kind, origin, files } = e.data;
  const post = (m: unknown) => (self as unknown as Worker).postMessage({ id, ...(m as object) });
  try {
    const inputs: InputFile[] = [];
    const notes: string[] = [];
    let total = 0;
    for (const f of files) {
      const bytes = new Uint8Array(f.data);
      const fmt = detectArchive(bytes, f.path);
      if (fmt) {
        post({ type: "progress", message: `Extracting ${f.path}…` });
        const r = readArchive(bytes, f.path, { maxTotalBytes: 400_000_000, maxEntryBytes: 30_000_000, maxEntries: 40_000 });
        const entries = stripCommonRoot(r.entries);
        for (const en of entries) { total += en.bytes; inputs.push({ path: en.path, data: en.data, origin: f.path, provenance: "user" }); }
        if (r.skipped.length) notes.push(`${r.skipped.length} archive entr${r.skipped.length === 1 ? "y" : "ies"} skipped by safety limits (traversal, size, ratio).`);
      } else {
        const safe = safeEntryPath(f.path);
        if (!safe) { notes.push(`Skipped unsafe path: ${f.path}`); continue; }
        total += bytes.byteLength;
        inputs.push({ path: safe, data: bytes, origin: "upload", provenance: "user" });
      }
      if (total > 600_000_000) { notes.push("Stopped reading: total size limit (600 MB) reached."); break; }
    }
    post({ type: "progress", message: `Analysing ${inputs.length} file(s)…` });
    const inv = await investigateSource(name, inputs, { kind: kind === "archive" ? "archive" : kind === "folder" ? "folder" : "files", origin });
    inv.limitations.push(...notes);
    post({ type: "done", inv });
  } catch (err) {
    post({ type: "error", message: (err as Error).message });
  }
};
