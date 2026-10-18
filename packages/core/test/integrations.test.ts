import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as gh from "../src/integrations/github";
import * as vc from "../src/integrations/vercel";
import { ProviderError } from "../src/ai/types";

type Call = { method: string; url: string; body: any; auth?: string };
let srv: http.Server, base: string;
const calls: Call[] = [];
let mode: "empty" | "existing" = "empty";
let vercelStates: string[] = [];

beforeAll(async () => {
  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
      const json = (code: number, o: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      const u = req.url!, m = req.method!;
      if (req.headers.authorization === "Bearer bad") return json(401, { message: "Bad credentials" });
      /* ---- GitHub ---- */
      if (m === "GET" && u === "/user") return json(200, { login: "octo", name: "Octo" });
      if (m === "POST" && u === "/user/repos") return body.name === "taken" ? json(422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] }) : json(201, { full_name: `octo/${body.name}`, html_url: `https://github.com/octo/${body.name}`, default_branch: "main", clone_url: `https://github.com/octo/${body.name}.git` });
      if (m === "GET" && u.startsWith("/repos/octo/r/git/ref/heads/")) return mode === "existing" && u.endsWith("/main") ? json(200, { object: { sha: "headsha" } }) : json(404, { message: "Not Found" });
      if (m === "GET" && u.startsWith("/repos/octo/r/commits")) return mode === "empty" ? json(409, { message: "Git Repository is empty." }) : json(200, [{ sha: "headsha" }]);
      if (m === "PUT" && u.startsWith("/repos/octo/r/contents/")) return json(201, { commit: { sha: "seedsha" } });
      if (m === "POST" && u === "/repos/octo/r/git/blobs") return json(201, { sha: `blob${calls.filter((c) => c.url.endsWith("/blobs")).length}` });
      if (m === "GET" && u.startsWith("/repos/octo/r/git/commits/")) return json(200, { tree: { sha: "basetree" } });
      if (m === "POST" && u === "/repos/octo/r/git/trees") return json(201, { sha: "newtree" });
      if (m === "POST" && u === "/repos/octo/r/git/commits") return json(201, { sha: "newcommit", html_url: "https://github.com/octo/r/commit/newcommit" });
      if (m === "POST" && u === "/repos/octo/r/git/refs") return json(201, {});
      if (m === "PATCH" && u.startsWith("/repos/octo/r/git/refs/heads/")) return json(200, {});
      if (m === "POST" && u === "/repos/octo/r/pulls") return json(201, { number: 7, html_url: "https://github.com/octo/r/pull/7" });
      /* ---- Vercel ---- */
      if (m === "POST" && u.startsWith("/v13/deployments")) return json(200, { id: "dpl_1", url: "my-app-abc.vercel.app", readyState: "QUEUED", inspectorUrl: "https://vercel.com/x/y/dpl_1" });
      if (m === "GET" && u.startsWith("/v13/deployments/dpl_1")) { const s = vercelStates.shift() ?? "READY"; return json(200, { id: "dpl_1", url: "my-app-abc.vercel.app", readyState: s, errorMessage: s === "ERROR" ? "Command failed: npm run build" : undefined }); }
      if (m === "GET" && u.startsWith("/v3/deployments/dpl_1/events")) return json(200, [{ text: "Installing…" }, { payload: { text: "Build failed" } }]);
      if (m === "GET" && u.startsWith("/v2/teams")) return json(200, { teams: [{ id: "team_1", slug: "acme", name: "Acme" }] });
      if (m === "GET" && u === "/ok") return json(200, {});
      json(404, { message: "nope" });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

const G = (token = "tok") => ({ token, api: base });
const V = (extra = {}) => ({ token: "vtok", api: base, sleep: async () => {}, ...extra });

describe("GitHub", () => {
  it("whoami and repo creation", async () => {
    expect(await gh.whoami(G())).toEqual({ login: "octo", name: "Octo" });
    expect(await gh.createRepo(G(), "demo", { private: false })).toMatchObject({ full_name: "octo/demo", url: "https://github.com/octo/demo" });
    expect(calls.at(-1)!.body).toMatchObject({ name: "demo", private: false, auto_init: false });
  });
  it("commits a whole tree (incl. binary) to an EMPTY repo: seeds, blobs, tree, commit, ref", async () => {
    mode = "empty"; calls.length = 0;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]);
    const r = await gh.commitFiles(G(), "octo/r", [{ path: "README.md", data: "# hi" }, { path: "logo.png", data: png }], { message: "Initial import" });
    expect(r).toMatchObject({ sha: "newcommit", branch: "main", files: 2, seeded: true });
    const blobs = calls.filter((c) => c.url.endsWith("/git/blobs"));
    expect(blobs).toHaveLength(2);
    expect(blobs[0]!.body).toEqual({ content: btoa("# hi"), encoding: "base64" });
    expect(Buffer.from(blobs[1]!.body.content, "base64")).toEqual(Buffer.from(png)); // binary survives exactly
    const tree = calls.find((c) => c.url.endsWith("/git/trees"))!;
    expect(tree.body.tree.map((t: any) => t.path)).toEqual(["README.md", "logo.png"]);
    expect(calls.find((c) => c.url.endsWith("/git/commits") && c.method === "POST")!.body.parents).toEqual(["seedsha"]);
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/repos/octo/r/git/refs", body: { ref: "refs/heads/main", sha: "newcommit" } });
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  });
  it("adds a commit on an existing branch with the head as parent and fast-forwards the ref", async () => {
    mode = "existing"; calls.length = 0;
    await gh.commitFiles(G(), "octo/r", [{ path: "a.txt", data: "x" }], { message: "Update" });
    expect(calls.find((c) => c.url.endsWith("/git/commits") && c.method === "POST")!.body.parents).toEqual(["headsha"]);
    expect(calls.find((c) => c.url.endsWith("/git/trees"))!.body.base_tree).toBe("basetree");
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { sha: "newcommit", force: false } });
  });
  it("creates branches and pull requests", async () => {
    mode = "existing";
    expect(await gh.createBranch(G(), "octo/r", "feature", "main")).toEqual({ branch: "feature", sha: "headsha" });
    expect(await gh.createPullRequest(G(), "octo/r", { title: "t", head: "feature", base: "main" })).toEqual({ number: 7, url: "https://github.com/octo/r/pull/7" });
  });
  it("validates branch names", () => {
    for (const ok of ["feature", "omniforge/ai-edit-1", "fix_2.0"]) expect(gh.branchNameProblem(ok)).toBeNull();
    for (const bad of ["", "has space", "a..b", "-x", "x/", "x.lock", "a//b", "a@{b", "a:b", "a^b", "/abs", ".hidden/x"]) expect(gh.branchNameProblem(bad), bad).not.toBeNull();
  });
  it("opens a pull request: branch from the base head, one commit, PR head=branch — never writes to the base", async () => {
    mode = "existing"; calls.length = 0;
    const pr = await gh.openPullRequest(G(), "octo/r", { files: [{ path: "a.txt", data: "x" }], branch: "omniforge/change", base: "main", title: "Add a.txt", body: "details" });
    expect(pr).toMatchObject({ number: 7, url: "https://github.com/octo/r/pull/7", commit: { sha: "newcommit", branch: "omniforge/change" } });
    expect(calls.find((c) => c.url.endsWith("/git/commits") && c.method === "POST")!.body).toMatchObject({ parents: ["headsha"], message: "Add a.txt" });
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/refs")).map((c) => c.body.ref)).toEqual(["refs/heads/omniforge/change"]);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false); // base branch ref untouched
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/repos/octo/r/pulls", body: { title: "Add a.txt", head: "omniforge/change", base: "main", body: "details" } });
  });
  it("refuses to open a pull request from the base branch itself, from a bad name, or against a base that does not exist", async () => {
    mode = "existing"; calls.length = 0;
    const f = [{ path: "a", data: "x" }];
    await expect(gh.openPullRequest(G(), "octo/r", { files: f, branch: "main", base: "main", title: "t" })).rejects.toThrow(/must differ/);
    await expect(gh.openPullRequest(G(), "octo/r", { files: f, branch: "bad name", base: "main", title: "t" })).rejects.toThrow(/branch name/i);
    await expect(gh.openPullRequest(G(), "octo/r", { files: f, branch: "x", base: "nope", title: "t" })).rejects.toThrow(/base branch “nope” does not exist/);
    await expect(gh.openPullRequest(G(), "octo/r", { files: [], branch: "x", base: "main", title: "t" })).rejects.toThrow(/no files/);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]); // nothing was written by any refused attempt
  });
  it("gives actionable errors", async () => {
    await expect(gh.whoami(G("bad"))).rejects.toThrow(/401.*token invalid or expired/);
    await expect(gh.createRepo(G(), "taken")).rejects.toThrow(/already exists/);
    const e = await gh.whoami(G("bad")).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).not.toMatch(/bad\b.*bad/); // token not echoed
  });
});

describe("Vercel", () => {
  it("creates a deployment from inline files with correct payload", async () => {
    calls.length = 0;
    const d = await vc.createDeployment(V({ teamId: "team_1" }), [{ path: "index.html", data: "<h1>hi</h1>" }, { path: "a/b.bin", data: new Uint8Array([1, 2, 3]) }], { name: "My App!", target: "production", framework: null });
    expect(d).toMatchObject({ id: "dpl_1", url: "https://my-app-abc.vercel.app" });
    const c = calls.at(-1)!;
    expect(c.url).toContain("teamId=team_1");
    expect(c.body.name).toBe("my-app-");
    expect(c.body.target).toBe("production");
    expect(c.body.files[0]).toEqual({ file: "index.html", data: btoa("<h1>hi</h1>"), encoding: "base64" });
    expect(c.auth).toBe("Bearer vtok");
  });
  it("polls until READY and reports each state", async () => {
    vercelStates = ["BUILDING", "BUILDING", "READY"];
    const seen: string[] = [];
    const r = await vc.waitForDeployment(V(), "dpl_1", (s) => seen.push(s));
    expect(r).toMatchObject({ state: "READY", url: "https://my-app-abc.vercel.app" });
    expect(seen).toEqual(["BUILDING", "READY"]);
  });
  it("NEVER reports a failed build as deployed; surfaces the error and log", async () => {
    vercelStates = ["BUILDING", "ERROR"];
    const r = await vc.waitForDeployment(V(), "dpl_1");
    expect(r.state).toBe("ERROR");
    expect(r.errorMessage).toMatch(/npm run build/);
    expect(await vc.buildLog(V(), "dpl_1")).toEqual(["Installing…", "Build failed"]);
  });
  it("times out instead of hanging", async () => {
    vercelStates = Array(1000).fill("BUILDING");
    let t = 0; const realNow = Date.now; Date.now = () => (t += 400_000);
    try { await expect(vc.waitForDeployment(V({ timeoutMs: 600_000 }), "dpl_1")).rejects.toThrow(/Timed out/); } finally { Date.now = realNow; }
  });
  it("lists teams and smoke-tests a URL for real", async () => {
    expect(await vc.listTeams(V())).toEqual([{ id: "team_1", slug: "acme", name: "Acme" }]);
    expect(await vc.smokeTest(`${base}/ok`)).toMatchObject({ ok: true, status: 200 });
    expect(await vc.smokeTest(`${base}/missing`)).toMatchObject({ ok: false, status: 404 });
  });
});
