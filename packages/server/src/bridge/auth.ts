/**
 * Bridge authentication & authorisation.
 *
 *  - The native app UI holds a random `uiToken` (never leaves the machine).
 *  - A web app pairs with a short-lived, single-use, rate-limited code that the
 *    user reads off the desktop app. Pairing yields an origin-bound session token
 *    with ONLY the safe default scopes; dangerous scopes (exec, fs write, …) can
 *    be granted only by the UI token — a paired website cannot grant itself.
 *  - Requests must carry the bearer token, a matching Origin, a custom header
 *    (forces a CORS preflight that we only approve for bound origins) and a Host
 *    header that is loopback (defeats DNS rebinding).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SAFE_SCOPES = ["analyze", "models", "detect"] as const;
export const DANGEROUS_SCOPES = ["fs:read", "fs:write", "exec", "cli", "rea", "git", "render", "install"] as const;
export type Scope = (typeof SAFE_SCOPES)[number] | (typeof DANGEROUS_SCOPES)[number];

export interface Principal { kind: "ui" | "session"; scopes: Set<Scope>; origin?: string; sessionId?: string }

const sha = (s: string) => createHash("sha256").update(s).digest();
const eq = (a: string, b: string) => { const x = sha(a), y = sha(b); return timingSafeEqual(x, y); };
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export class AuthError extends Error { constructor(public status: number, message: string) { super(message); } }

export class BridgeAuth {
  readonly uiToken: string;
  private codes = new Map<string, number>(); // code → expiry
  private sessions = new Map<string, { id: string; origin: string; scopes: Set<Scope>; expires: number }>(); // sha256(token) hex → session
  private attempts: number[] = [];
  constructor(private o: { port: number; uiToken?: string; staticOrigins?: string[]; now?: () => number; sessionTtlMs?: number; codeTtlMs?: number } = { port: 0 }) {
    this.uiToken = o.uiToken ?? randomBytes(32).toString("hex");
  }
  private now() { return (this.o.now ?? Date.now)(); }
  private get staticOrigins() { return new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", ...(this.o.staticOrigins ?? [])]); }

  /** Host header must be loopback on our port (DNS-rebinding defence). */
  hostOk(host: string | null): boolean {
    if (!host) return false;
    return [`127.0.0.1:${this.o.port}`, `localhost:${this.o.port}`, `[::1]:${this.o.port}`].includes(host.toLowerCase());
  }

  newPairingCode(): { code: string; expiresAt: number } {
    const b = randomBytes(8);
    const code = Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join("");
    const expiresAt = this.now() + (this.o.codeTtlMs ?? 120_000);
    this.codes.set(code, expiresAt);
    for (const [c, e] of this.codes) if (e < this.now()) this.codes.delete(c);
    return { code, expiresAt };
  }

  /** Single-use. 5 attempts/minute globally, so 40-bit codes cannot be brute-forced. */
  pair(code: string, origin: string | null): { token: string; scopes: Scope[]; expiresAt: number; sessionId: string } {
    const t = this.now();
    this.attempts = this.attempts.filter((a) => t - a < 60_000);
    if (this.attempts.length >= 5) throw new AuthError(429, "Too many pairing attempts. Wait a minute and generate a new code.");
    this.attempts.push(t);
    if (!origin) throw new AuthError(400, "Pairing must come from a browser origin");
    const key = code.trim().toUpperCase();
    const exp = this.codes.get(key);
    if (!exp || exp < t) throw new AuthError(401, "Invalid or expired pairing code");
    this.codes.delete(key); // single use
    const token = randomBytes(32).toString("hex");
    const id = randomBytes(6).toString("hex");
    const expires = t + (this.o.sessionTtlMs ?? 12 * 3600_000);
    const scopes = new Set<Scope>(SAFE_SCOPES);
    this.sessions.set(sha(token).toString("hex"), { id, origin, scopes, expires });
    return { token, scopes: [...scopes], expiresAt: expires, sessionId: id };
  }

  /** Authenticate a request; null = anonymous. Throws AuthError for hard failures (bad host / csrf). */
  authenticate(headers: Headers): Principal | null {
    if (!this.hostOk(headers.get("host"))) throw new AuthError(403, "Bad Host header");
    const auth = headers.get("authorization");
    if (!auth?.startsWith("Bearer ")) return null;
    const token = auth.slice(7).trim();
    const origin = headers.get("origin");
    if (eq(token, this.uiToken)) {
      if (origin && !this.staticOrigins.has(origin)) throw new AuthError(403, "Origin not allowed for the app token");
      return { kind: "ui", scopes: new Set<Scope>([...SAFE_SCOPES, ...DANGEROUS_SCOPES]), origin: origin ?? undefined };
    }
    const s = this.sessions.get(sha(token).toString("hex"));
    if (!s) return null;
    if (s.expires < this.now()) { this.sessions.delete(sha(token).toString("hex")); return null; }
    if (origin !== s.origin) throw new AuthError(403, "This token is bound to a different origin");
    return { kind: "session", scopes: s.scopes, origin: s.origin, sessionId: s.id };
  }

  requireCsrf(headers: Headers, method: string) {
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    if (headers.get("x-omniforge-bridge") !== "1") throw new AuthError(403, "Missing x-omniforge-bridge header");
  }

  /** Only the UI principal may call this. */
  grantScope(sessionId: string, scope: Scope, on = true) {
    for (const s of this.sessions.values()) if (s.id === sessionId) { on ? s.scopes.add(scope) : s.scopes.delete(scope); return true; }
    return false;
  }
  revokeSession(sessionId: string) { for (const [k, s] of this.sessions) if (s.id === sessionId) this.sessions.delete(k); }
  listSessions() { return [...this.sessions.values()].map((s) => ({ id: s.id, origin: s.origin, scopes: [...s.scopes], expires: s.expires })); }

  /** CORS: only static + currently-bound origins (and `*` for the unauthenticated health probe). */
  allowOrigin(origin: string | null): string | null {
    if (!origin) return null;
    if (this.staticOrigins.has(origin)) return origin;
    for (const s of this.sessions.values()) if (s.origin === origin) return origin;
    return null;
  }
  /** During pairing the origin is not yet bound; allow it only for the /pair route itself. */
}

export function need(p: Principal | null, scope: Scope): Principal {
  if (!p) throw new AuthError(401, "Not authenticated. Pair this app with the desktop companion first.");
  if (!p.scopes.has(scope)) throw new AuthError(403, `This session lacks the “${scope}” permission. Approve it in the desktop app (Settings → Connections).`);
  return p;
}
