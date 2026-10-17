import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { investigateSource } from "../src/analyze/sourceInvestigation";
import { readArchive, stripCommonRoot } from "../src/analyze/archive";
import { renderMarkdown } from "../src/report/report";

const f = (path: string, s: string) => ({ path, data: strToU8(s) });
const STRIPE = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");

describe("investigateSource", () => {
  it("produces a full Investigation from an uploaded ZIP of a Next.js app", async () => {
    const zip = zipSync({
      "demo-main/package.json": strToU8(JSON.stringify({ name: "demo", dependencies: { next: "^15.0.0", react: "^19", "next-auth": "5", stripe: "17", "@xyflow/react": "12" }, devDependencies: { vitest: "3" } })),
      "demo-main/app/page.tsx": strToU8(`import { Flow } from "../components/Flow";\nexport default function Home(){ return <Flow/> }`),
      "demo-main/app/login/page.tsx": strToU8(`export default function Login(){ return <form/> }`),
      "demo-main/components/Flow.tsx": strToU8(`export function Flow(){ fetch("/api/graph"); return <div/> }`),
      "demo-main/app/api/graph/route.ts": strToU8(`export async function GET(){ return Response.json({}) }`),
      "demo-main/prisma/schema.prisma": strToU8("model User {\n id Int @id\n}"),
      "demo-main/lib/pay.ts": strToU8(`export const key = "${STRIPE}";`),
      "demo-main/.env.example": strToU8("DATABASE_URL=\n"),
    });
    const inv = await investigateSource("demo", stripCommonRoot(readArchive(zip, "demo.zip").entries).map((e) => ({ path: e.path, data: e.data })), { kind: "archive", origin: "demo.zip" });
    expect(inv.status).toBe("done");
    const names = inv.technologies.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["Next.js", "React", "NextAuth.js / Auth.js", "Stripe", "React Flow", "TypeScript"]));
    expect(inv.technologies.find((t) => t.name === "Next.js")).toMatchObject({ version: "15.0.0", confidence: 0.95 });
    for (const t of inv.technologies) for (const id of t.evidence) expect(inv.evidence.some((e) => e.id === id), `${t.name}:${id}`).toBe(true);
    expect(inv.features.map((x) => x.name)).toEqual(expect.arrayContaining(["Routing & pages", "Authentication", "Data model & persistence", "Payments", "Interactive node graph", "Server-side API"]));
    expect(inv.routes!.map((r) => r.route)).toEqual(["/", "/login"]);
    expect(inv.envVars!.map((e) => e.name)).toContain("DATABASE_URL");
    expect(inv.findings.find((x) => /Secret-shaped/.test(x.title))).toMatchObject({ severity: "high" });
    expect(JSON.stringify(inv.findings)).not.toContain(STRIPE);
    expect(inv.graph.edges.some((e) => e.source === "file:app/page.tsx" && e.target === "file:components/Flow.tsx")).toBe(true);
    expect(inv.coverage.checks.find((c) => c.id === "runtime")!.status).toBe("skipped");
    const md = renderMarkdown(inv);
    expect(md).toMatch(/## 9\. Feature inventory/);
    expect(md).not.toContain(STRIPE);
  });
  it("handles empty and binary-only inputs without inventing anything", async () => {
    const inv = await investigateSource("empty", []);
    expect(inv.technologies).toEqual([]);
    expect(inv.features).toEqual([]);
    expect(inv.coverage.checks.find((c) => c.id === "server")!.status).toBe("unavailable");
  });
});
