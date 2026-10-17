/** IndexedDB key/value with a safe in-memory fallback (private windows, blocked storage). */
import { createStore, del as idel, get as iget, keys as ikeys, set as iset, type UseStore } from "idb-keyval";

let store: UseStore | undefined;
const mem = new Map<string, unknown>();
let broken = false;
try { if (typeof indexedDB !== "undefined") store = createStore("omniforge", "kv"); } catch { broken = true; }

export const db = {
  persistent: () => !!store && !broken,
  async get<T>(k: string): Promise<T | undefined> { if (store && !broken) { try { return await iget<T>(k, store); } catch { broken = true; } } return mem.get(k) as T | undefined; },
  async set(k: string, v: unknown) { if (store && !broken) { try { return await iset(k, v, store); } catch { broken = true; } } mem.set(k, v); },
  async del(k: string) { if (store && !broken) { try { return await idel(k, store); } catch { broken = true; } } mem.delete(k); },
  async keys(): Promise<string[]> { if (store && !broken) { try { return (await ikeys(store)) as string[]; } catch { broken = true; } } return [...mem.keys()]; },
};

export const ls = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or blocked */ } },
  raw(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  setRaw(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
};
