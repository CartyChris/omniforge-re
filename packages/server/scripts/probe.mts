import { detectClis, ADAPTERS, probeCli, testCli } from "../src/bridge/clis";
import { detectTools, systemInfo } from "../src/bridge/detect";
const sys = await systemInfo(); console.log("SYSTEM", JSON.stringify(sys));
const tools = await detectTools();
console.log("TOOLS", tools.map((t) => `${t.id}:${t.status}${t.version ? "@" + t.version : ""}`).join(" "));
const clis = await detectClis();
for (const c of clis) console.log("CLI", c.id, c.status, c.version ?? "", c.method ?? "", JSON.stringify(c.methods.map((m) => `${m.id}:${m.supported}`)), "auth=" + c.authenticated);
const claude = ADAPTERS.find((a) => a.id === "claude-code")!;
const info = await probeCli(claude);
if (info.status === "ready" || info.status === "installed-unauthenticated") { const v = await testCli(claude, info, 120000); console.log("CLAUDE TEST", JSON.stringify(v)); }
