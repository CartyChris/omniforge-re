import { describe, expect, it } from "vitest";
import { analyzeTechnicalArtifacts, detectArtifact, investigateSource, redactUrl } from "../src/index";

const enc = (s: string) => new TextEncoder().encode(s);
const file = (path: string, s: string) => ({ path, data: enc(s) });
// built at runtime so the repository never contains a secret-shaped literal
const fakeToken = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");

const OPENAPI_YAML = `openapi: 3.0.3
info: { title: Pet Store, version: 1.2.0 }
servers: [{ url: "https://api.pets.example/v1" }]
components:
  securitySchemes: { bearerAuth: { type: http, scheme: bearer } }
paths:
  /pets:
    get:
      tags: [pets]
      summary: List pets
      parameters: [{ name: limit, in: query, required: false }]
      responses: { "200": { description: ok }, "400": { description: bad request } }
    post:
      tags: [pets]
      requestBody: { content: { application/json: {} } }
      responses: { "201": { description: created }, "401": { description: unauthorised } }
  /owners/{id}:
    get: { tags: [owners], parameters: [{ name: id, in: path, required: true }], responses: { "200": { description: ok }, "404": { description: missing } } }
`;

const HAR = JSON.stringify({ log: { version: "1.2", creator: { name: "WebInspector" }, entries: [
  { time: 120, request: { method: "GET", url: "https://app.example/index.html", headers: [{ name: "Cookie", value: `session=${fakeToken}` }] }, response: { status: 200, headers: [{ name: "Server", value: "nginx/1.25" }, { name: "Set-Cookie", value: `sid=${fakeToken}; Path=/` }], content: { mimeType: "text/html", text: "<html>SECRET-BODY</html>" } } },
  { time: 80, request: { method: "POST", url: `https://app.example/api/login?token=${fakeToken}&next=/home`, headers: [{ name: "Authorization", value: `Bearer ${fakeToken}` }], postData: { text: '{"password":"hunter2"}' } }, response: { status: 500, headers: [], content: { mimeType: "application/json", text: '{"err":1}' } } },
  { time: 4500, request: { method: "GET", url: "http://cdn.tracker.example/pixel.js", headers: [] }, response: { status: 200, headers: [], content: { mimeType: "application/javascript" } } },
] } });

describe("technical artifact detection", () => {
  it("recognises artifacts by content, not only by name", () => {
    expect(detectArtifact("export.txt", OPENAPI_YAML)).toBe("openapi");
    expect(detectArtifact("api.json", '{"swagger":"2.0","paths":{}}')).toBe("openapi");
    expect(detectArtifact("capture.json", HAR)).toBe("har");
    expect(detectArtifact("x.json", '{"bomFormat":"CycloneDX","components":[]}')).toBe("sbom");
    expect(detectArtifact("schema.txt", "type Query {\n  a: Int\n}")).toBe("graphql");
    expect(detectArtifact("package.json", '{"name":"x","dependencies":{}}')).toBeNull();
  });
});

describe("OpenAPI", () => {
  const a = analyzeTechnicalArtifacts([file("openapi.yaml", OPENAPI_YAML)]);
  it("lists every operation as an endpoint with evidence", () => {
    expect(a.endpoints.map((e) => `${e.method} ${e.url}`).sort()).toEqual(["GET https://api.pets.example/v1/owners/{id}", "GET https://api.pets.example/v1/pets", "POST https://api.pets.example/v1/pets"]);
    expect(a.endpoints.every((e) => a.evidence.some((x) => x.id === e.evidence))).toBe(true);
  });
  it("groups operations into features with inputs, outputs and error states", () => {
    const pets = a.features.find((f) => f.name === "API: pets")!;
    expect(pets.spec.inputs).toContain("query:limit");
    expect(pets.spec.inputs.some((i) => i.includes("application/json"))).toBe(true);
    expect(pets.spec.errorStates.join(" ")).toContain("400");
    expect(pets.spec.dependencies).toEqual(["bearerAuth (http/bearer)"]);
    expect(pets.provenance).toBe("observed");
  });
  it("reports unparseable specs instead of inventing results", () => {
    const bad = analyzeTechnicalArtifacts([file("openapi.json", '{"openapi": "3.0.0", "paths": ')]);
    expect(bad.endpoints).toEqual([]);
  });
});

describe("HAR privacy", () => {
  const a = analyzeTechnicalArtifacts([file("session.har", HAR)]);
  const dump = JSON.stringify(a);
  it("never retains credentials, cookies, query secrets or bodies", () => {
    expect(dump).not.toContain(fakeToken);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("SECRET-BODY");
    expect(a.endpoints.find((e) => e.url.includes("/api/login"))!.url).toBe("https://app.example/api/login"); // query dropped entirely from the stored URL
    expect(redactUrl(`https://x.example/a?token=${fakeToken}&q=1`)).toBe("https://x.example/a?token=REDACTED&q=1");
  });
  it("derives technologies, third parties and findings from what was actually captured", () => {
    expect(a.technologies.map((t) => t.name)).toContain("nginx");
    expect(a.thirdParties.map((t) => t.host)).toContain("cdn.tracker.example");
    const titles = a.findings.map((f) => f.title).join("\n");
    expect(titles).toMatch(/server error/); expect(titles).toMatch(/longer than 3 s/); expect(titles).toMatch(/plain http/);
  });
});

describe("SBOM", () => {
  it("maps CycloneDX components (purl → ecosystem) and flags copyleft licences", () => {
    const bom = JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [{ name: "left-pad", version: "1.3.0", purl: "pkg:npm/left-pad@1.3.0", licenses: [{ license: { id: "MIT" } }] }, { name: "requests", version: "2.31.0", purl: "pkg:pypi/requests@2.31.0" }, { name: "gpl-thing", version: "1", purl: "pkg:maven/x/gpl-thing@1", licenses: [{ license: { id: "GPL-3.0-only" } }] }] });
    const a = analyzeTechnicalArtifacts([file("bom.json", bom)]);
    expect(a.dependencies.map((d) => `${d.ecosystem}:${d.name}@${d.version}`)).toEqual(["npm:left-pad@1.3.0", "pypi:requests@2.31.0", "maven:gpl-thing@1"]);
    expect(a.findings.some((f) => /strong-copyleft/.test(f.title))).toBe(true);
  });
  it("reads SPDX JSON", () => {
    const a = analyzeTechnicalArtifacts([file("sbom.spdx.json", JSON.stringify({ spdxVersion: "SPDX-2.3", packages: [{ name: "zlib", versionInfo: "1.3", externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:cargo/zlib@1.3" }] }] }))]);
    expect(a.dependencies[0]).toMatchObject({ name: "zlib", ecosystem: "cargo" });
  });
});

describe("GraphQL and logs", () => {
  it("lists root operations with arguments", () => {
    const a = analyzeTechnicalArtifacts([file("schema.graphql", `# comment\ntype Query {\n  user(id: ID!): User\n  users(\n    first: Int\n  ): [User!]!\n}\ntype Mutation { createUser(name: String!): User }\ntype User { id: ID! name: String }`)]);
    expect(a.endpoints.map((e) => `${e.method} ${e.url}`)).toEqual(["QUERY graphql://Query.user", "QUERY graphql://Query.users", "MUTATION graphql://Mutation.createUser"]);
    expect(a.features.map((f) => f.name)).toEqual(["GraphQL Querys", "GraphQL Mutations"]);
  });
  it("summarises errors from logs without leaking secrets", () => {
    const log = Array.from({ length: 5 }, (_, i) => `2026-01-0${i + 1}T10:00:00Z ERROR db timeout after ${i + 100} ms token=${fakeToken}`).concat(["2026-01-01T10:00:01Z INFO started", "2026-01-01T10:00:02Z WARN slow"]).join("\n");
    const a = analyzeTechnicalArtifacts([file("app.log", log)]);
    expect(JSON.stringify(a)).not.toContain(fakeToken);
    expect(a.findings[0]!.title).toMatch(/5 error line/);
    expect(a.findings[0]!.detail).toMatch(/5× “/);
  });
});

describe("through investigateSource", () => {
  it("merges artifacts into the same Investigation as source files and records coverage", async () => {
    const inv = await investigateSource("bundle", [file("openapi.yaml", OPENAPI_YAML), file("session.har", HAR), file("src/a.ts", "export const a = 1;\n")], { kind: "files" });
    expect(inv.endpoints.length).toBe(4); // 3 documented operations + the one API call seen in the capture
    expect(inv.features.some((f) => f.name === "API: pets")).toBe(true);
    expect(inv.coverage.checks.find((c) => c.id === "artifacts")?.status).toBe("done");
    expect(inv.thirdParties?.map((t) => t.host)).toContain("cdn.tracker.example");
    expect(JSON.stringify(inv)).not.toContain(fakeToken);
    for (const e of inv.endpoints) expect(e.evidence === "" || inv.evidence.some((x) => x.id === e.evidence)).toBe(true);
  });
});

describe("secrets are never stored in investigation content", () => {
  const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  it("redacts secret-shaped values from stored file content but leaves ordinary code untouched", async () => {
    const inv = await investigateSource("leaky", [
      file("src/config.ts", `export const API_KEY = process.env.API_KEY;\nconst aws = "${awsKey}";\n`),
      file(".env", `DATABASE_PASSWORD=correct-horse-battery\nPUBLIC_URL=https://x.example\n`),
      file("session.har", HAR),
    ], { kind: "files" });
    const cfg = inv.files.find((f) => f.path === "src/config.ts")!;
    expect(cfg.content).toContain("export const API_KEY = process.env.API_KEY;"); // code is not rewritten
    expect(cfg.content).not.toContain(awsKey); expect(cfg.content).toContain("[REDACTED:aws-access-key]");
    expect(cfg.redacted).toEqual(["aws-access-key"]);
    const env = inv.files.find((f) => f.path === ".env")!;
    expect(env.content).not.toContain("correct-horse-battery"); expect(env.content).toContain("PUBLIC_URL=https://x.example");
    const harFile = inv.files.find((f) => f.path === "session.har")!;
    expect(harFile.content).toBeUndefined(); expect(harFile.redacted).toEqual(["har-capture-not-stored"]);
    const dump = JSON.stringify(inv);
    for (const secret of [awsKey, "correct-horse-battery", fakeToken, "hunter2", "SECRET-BODY"]) expect(dump, secret).not.toContain(secret);
  });
  it("also protects the exported bundle", async () => {
    const { exportBundle } = await import("../src/report/report");
    const { unzipSync, strFromU8 } = await import("fflate");
    const inv = await investigateSource("leaky", [file("src/config.ts", `const aws = "${awsKey}";\n`)], { kind: "files" });
    const zip = unzipSync(exportBundle(inv));
    for (const [name, data] of Object.entries(zip)) expect(strFromU8(data), name).not.toContain(awsKey);
  });
});
