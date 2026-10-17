import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError, BridgeAuth, need } from "../src/bridge/auth";
import { FsError, Roots, listTree, maskEnv, readText, snapshotFolder, writeText } from "../src/bridge/fsx";

const H = (o: Record<string, string>) => new Headers({ host: "127.0.0.1:4455", ...o });
let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-sec-")); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("pairing & authentication", () => {
  it("pairs once with a short-lived code, binding the token to the web origin and granting only safe scopes", () => {
    let t = 1_000_000;
    const a = new BridgeAuth({ port: 4455, now: () => t });
    const { code } = a.newPairingCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    const s = a.pair(code, "https://omniforge.vercel.app");
    expect(s.scopes.sort()).toEqual(["analyze", "detect", "models"]);
    expect(() => a.pair(code, "https://omniforge.vercel.app")).toThrow(/Invalid or expired/); // single use
    const p = a.authenticate(H({ authorization: `Bearer ${s.token}`, origin: "https://omniforge.vercel.app" }))!;
    expect(p).toMatchObject({ kind: "session", origin: "https://omniforge.vercel.app" });
    // a different website cannot use a stolen token
    expect(() => a.authenticate(H({ authorization: `Bearer ${s.token}`, origin: "https://evil.example" }))).toThrow(/different origin/);
    expect(() => a.authenticate(H({ authorization: `Bearer ${s.token}` }))).toThrow(/different origin/);
    // codes expire
    const c2 = a.newPairingCode();
    t += 121_000;
    expect(() => a.pair(c2.code, "https://x.example")).toThrow(/expired/);
  });
  it("rate-limits pairing attempts so codes cannot be brute-forced", () => {
    const a = new BridgeAuth({ port: 4455 });
    a.newPairingCode();
    for (let i = 0; i < 5; i++) expect(() => a.pair("AAAAAAAA", "https://x.example")).toThrow(/Invalid/);
    const e = (() => { try { a.pair("AAAAAAAA", "https://x.example"); } catch (x) { return x as AuthError; } })()!;
    expect(e.status).toBe(429);
  });
  it("a paired website cannot grant itself dangerous scopes; only the UI can", () => {
    const a = new BridgeAuth({ port: 4455 });
    const s = a.pair(a.newPairingCode().code, "https://web.example");
    const principal = a.authenticate(H({ authorization: `Bearer ${s.token}`, origin: "https://web.example" }))!;
    expect(() => need(principal, "exec")).toThrow(/lacks the “exec” permission/);
    expect(() => need(principal, "analyze")).not.toThrow();
    expect(a.grantScope(s.sessionId, "fs:read")).toBe(true); // called by the UI path
    expect(() => need(a.authenticate(H({ authorization: `Bearer ${s.token}`, origin: "https://web.example" })), "fs:read")).not.toThrow();
    a.revokeSession(s.sessionId);
    expect(a.authenticate(H({ authorization: `Bearer ${s.token}`, origin: "https://web.example" }))).toBeNull();
  });
  it("the app token works only from the app's own origins", () => {
    const a = new BridgeAuth({ port: 4455 });
    expect(a.authenticate(H({ authorization: `Bearer ${a.uiToken}`, origin: "tauri://localhost" }))!.kind).toBe("ui");
    expect(a.authenticate(H({ authorization: `Bearer ${a.uiToken}` }))!.scopes.has("exec")).toBe(true);
    expect(() => a.authenticate(H({ authorization: `Bearer ${a.uiToken}`, origin: "https://evil.example" }))).toThrow(/Origin not allowed/);
  });
  it("rejects DNS-rebinding Host headers and requires the CSRF header on writes", () => {
    const a = new BridgeAuth({ port: 4455 });
    expect(() => a.authenticate(new Headers({ host: "evil.example:4455" }))).toThrow(/Bad Host/);
    expect(() => a.authenticate(new Headers({ host: "127.0.0.1:9999" }))).toThrow(/Bad Host/);
    expect(a.hostOk("localhost:4455")).toBe(true);
    expect(() => a.requireCsrf(new Headers(), "POST")).toThrow(/x-omniforge-bridge/);
    expect(() => a.requireCsrf(new Headers({ "x-omniforge-bridge": "1" }), "POST")).not.toThrow();
    expect(() => a.requireCsrf(new Headers(), "GET")).not.toThrow();
  });
  it("only allows CORS for the app and currently bound origins", () => {
    const a = new BridgeAuth({ port: 4455 });
    expect(a.allowOrigin("https://web.example")).toBeNull();
    a.pair(a.newPairingCode().code, "https://web.example");
    expect(a.allowOrigin("https://web.example")).toBe("https://web.example");
    expect(a.allowOrigin("https://other.example")).toBeNull();
    expect(a.allowOrigin("tauri://localhost")).toBe("tauri://localhost");
  });
  it("unauthenticated requests are anonymous (and need() refuses them)", () => {
    const a = new BridgeAuth({ port: 4455 });
    expect(a.authenticate(H({}))).toBeNull();
    expect(() => need(null, "analyze")).toThrow(/Not authenticated/);
  });
});

describe("approved-root filesystem", () => {
  it("lists, reads and writes only inside an approved root; writes need a writable root", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "proj-"));
    fs.mkdirSync(path.join(dir, "src")); fs.writeFileSync(path.join(dir, "src/a.ts"), "export const a = 1;"); fs.mkdirSync(path.join(dir, "node_modules")); fs.writeFileSync(path.join(dir, "node_modules/x.js"), "x");
    const roots = new Roots();
    const ro = await roots.add(dir);
    const { entries } = await listTree(roots, ro.id);
    expect(entries.map((e) => e.path)).toEqual(["src", "src/a.ts"]); // node_modules ignored
    expect((await readText(roots, ro.id, "src/a.ts")).content).toBe("export const a = 1;");
    await expect(writeText(roots, ro.id, "src/b.ts", "x")).rejects.toThrow(/read-only/);
    const rw = await roots.add(dir, { writable: true });
    expect(await writeText(roots, rw.id, "src/b.ts", "ok")).toMatchObject({ bytes: 2 });
    expect(fs.readFileSync(path.join(dir, "src/b.ts"), "utf8")).toBe("ok");
  });
  it("blocks traversal, absolute paths, unapproved roots and symlink escapes", async () => {
    const outside = fs.mkdtempSync(path.join(tmp, "outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
    const dir = fs.mkdtempSync(path.join(tmp, "proj-"));
    fs.symlinkSync(outside, path.join(dir, "link"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "file-link"));
    const roots = new Roots();
    const r = await roots.add(dir, { writable: true });
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "link/secret.txt", "file-link", "\0x"]) await expect(readText(roots, r.id, bad), bad).rejects.toThrow(FsError);
    await expect(writeText(roots, r.id, "link/new.txt", "pwned")).rejects.toThrow(/escapes|outside/);
    expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false);
    await expect(readText(roots, "nonexistent", "a")).rejects.toThrow(/not been approved/);
    const tree = await listTree(roots, r.id);
    expect(tree.entries.map((e) => e.path)).not.toContain("link/secret.txt"); // symlinks are not followed when listing
  });
  it("refuses to approve a filesystem root or your whole home directory", async () => {
    const roots = new Roots();
    await expect(roots.add("/")).rejects.toThrow(/project folder/);
    const prev = process.env.HOME;
    process.env.HOME = tmp;
    await expect(roots.add(tmp)).rejects.toThrow(/project folder/);
    process.env.HOME = prev;
  });
  it("never returns .env VALUES (names only), in reads and in analysis snapshots", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "env-"));
    fs.writeFileSync(path.join(dir, ".env"), "DATABASE_URL=postgres://u:hunter2@h/db\nAPI_KEY=abc123secret\n");
    fs.writeFileSync(path.join(dir, ".env.example"), "DATABASE_URL=\n");
    fs.writeFileSync(path.join(dir, "id_rsa"), "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----");
    const roots = new Roots();
    const r = await roots.add(dir);
    const read = await readText(roots, r.id, ".env");
    expect(read.masked).toBe(true);
    expect(read.content).not.toMatch(/hunter2|abc123secret/);
    expect(read.content).toContain("DATABASE_URL=[HIDDEN]");
    const snap = await snapshotFolder(roots, r.id);
    const text = snap.files.map((f) => new TextDecoder().decode(f.data)).join("\n");
    expect(text).not.toMatch(/hunter2|abc123secret|BEGIN PRIVATE KEY|MIIE/);
    expect(snap.files.find((f) => f.path === ".env.example") && new TextDecoder().decode(snap.files.find((f) => f.path === ".env.example")!.data)).toBe("DATABASE_URL=\n"); // examples pass through
    const rw = await roots.add(dir, { writable: true });
    await expect(writeText(roots, rw.id, ".env", "X=1")).rejects.toThrow(/credential-style/); // writing secrets is refused too
    expect(maskEnv("A=1\nB=2")).toBe("# Values hidden by OmniForge. Variable names only:\nA=[HIDDEN]\nB=[HIDDEN]\n");
  });
  it("enforces snapshot limits", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "big-"));
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "x".repeat(1000));
    fs.writeFileSync(path.join(dir, "huge.bin"), Buffer.alloc(50_000));
    const roots = new Roots();
    const r = await roots.add(dir);
    const s = await snapshotFolder(roots, r.id, { maxFiles: 5, maxFileBytes: 10_000 });
    expect(s.files).toHaveLength(5);
    expect(s.skipped.map((x) => x.reason).join()).toMatch(/file-count limit/);
    expect(s.skipped.some((x) => x.path === "huge.bin" && /too large/.test(x.reason))).toBe(true);
  });
});
