/**
 * Credential vault for API keys and tokens. Secrets are AES-GCM encrypted at rest
 * in IndexedDB (never in localStorage, never in project exports).
 *
 *  • Device mode (default): a non-extractable CryptoKey kept in IndexedDB. Protects
 *    against reading keys out of disk/exports/backups; does NOT protect against
 *    script running in this origin.
 *  • Passphrase mode (optional): key derived with PBKDF2 (600k) from a passphrase
 *    that is never stored; the vault is locked until unlocked each session.
 *
 * On the desktop app, credentials go to the macOS Keychain instead (see desktop.ts).
 */
import { db } from "./storage";
import { isTauri } from "./bridge";

/** On the desktop app credentials live in the macOS Keychain (Rust commands), not in the browser database. */
const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<T> } }).__TAURI_INTERNALS__.invoke(cmd, args);
let keychainOk: boolean | undefined;
async function useKeychain() { if (!isTauri()) return false; if (keychainOk === undefined) keychainOk = await invoke<string[]>("keychain_names").then(() => true, () => false); return keychainOk; }

type Blob = { iv: string; ct: string };
type Meta = { mode: "device" | "passphrase"; salt?: string };
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let sessionKey: CryptoKey | null = null; // passphrase mode
let cache: Record<string, string> | null = null;

async function meta(): Promise<Meta> { return (await db.get<Meta>("vault:meta")) ?? { mode: "device" }; }
async function deviceKey(): Promise<CryptoKey> {
  let k = await db.get<CryptoKey>("vault:devicekey");
  if (!k) { k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); await db.set("vault:devicekey", k); }
  return k;
}
async function derive(pass: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt as BufferSource, iterations: 600_000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function activeKey(): Promise<CryptoKey> {
  const m = await meta();
  if (m.mode === "passphrase") { if (!sessionKey) throw new VaultLocked(); return sessionKey; }
  return deviceKey();
}
export class VaultLocked extends Error { constructor() { super("The credential vault is locked. Enter your passphrase in Settings → Security."); this.name = "VaultLocked"; } }

async function load(): Promise<Record<string, string>> {
  if (cache) return cache;
  const blob = await db.get<Blob>("vault:data");
  if (!blob) return (cache = {});
  const key = await activeKey();
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) as BufferSource }, key, unb64(blob.ct) as BufferSource);
    return (cache = JSON.parse(new TextDecoder().decode(pt)));
  } catch { throw new Error("Could not decrypt the credential vault (wrong passphrase or corrupted data)."); }
}
async function save(data: Record<string, string>) {
  const key = await activeKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data))));
  await db.set("vault:data", { iv: b64(iv), ct: b64(ct) } satisfies Blob);
  cache = data;
}

export const vault = {
  async get(name: string): Promise<string | undefined> { if (await useKeychain()) return (await invoke<string | null>("keychain_get", { name })) ?? undefined; return (await load())[name]; },
  async set(name: string, value: string) { if (await useKeychain()) return void (await invoke("keychain_set", { name, value })); await save({ ...(await load()), [name]: value }); },
  async del(name: string) { if (await useKeychain()) return void (await invoke("keychain_delete", { name })); const d = { ...(await load()) }; delete d[name]; await save(d); },
  async names(): Promise<string[]> { if (await useKeychain()) return invoke<string[]>("keychain_names").catch(() => []); try { return Object.keys(await load()); } catch { return []; } },
  async mode(): Promise<"device" | "passphrase" | "keychain"> { if (await useKeychain()) return "keychain"; return (await meta()).mode; },
  async locked() { if (await useKeychain()) return false; const m = await meta(); return m.mode === "passphrase" && !sessionKey; },
  /** Switch to passphrase mode, re-encrypting existing secrets. */
  async enablePassphrase(pass: string) {
    if (pass.length < 8) throw new Error("Use at least 8 characters.");
    const data = await load();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    sessionKey = await derive(pass, salt);
    await db.set("vault:meta", { mode: "passphrase", salt: b64(salt) } satisfies Meta);
    await save(data);
  },
  async unlock(pass: string) {
    const m = await meta();
    if (m.mode !== "passphrase" || !m.salt) return;
    const k = await derive(pass, unb64(m.salt));
    sessionKey = k; cache = null;
    try { await load(); } catch (e) { sessionKey = null; throw e; }
  },
  lock() { sessionKey = null; cache = null; },
  async disablePassphrase() { const data = await load(); await db.set("vault:meta", { mode: "device" } satisfies Meta); sessionKey = null; cache = null; await save(data); },
  async wipe() { if (await useKeychain()) { for (const n of await invoke<string[]>("keychain_names")) await invoke("keychain_delete", { name: n }); return; } cache = null; sessionKey = null; await db.del("vault:data"); await db.del("vault:meta"); },
};
