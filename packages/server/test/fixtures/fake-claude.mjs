#!/usr/bin/env node
// A SCRIPTED stand-in for `claude -p --output-format stream-json` (plumbing tests only; the real CLI is covered by the opt-in live test).
// It reads the prompt from stdin like the real one, emits events in the recorded shape, and performs file operations selected by FAKE_MODE.
import fs from "node:fs";
import path from "node:path";
const mode = process.env.FAKE_MODE ?? "edit";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let prompt = ""; for await (const c of process.stdin) prompt += c;
out({ type: "system", subtype: "init", model: "fake-model", tools: ["Read", "Edit", "Write", "Glob", "Grep"] });
const tool = (name, input) => out({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const done = (text = "done") => { out({ type: "assistant", message: { content: [{ type: "text", text }] } }); out({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, num_turns: 2, duration_ms: 5 }); };
const w = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); tool("Write", { file_path: p }); };
if (mode === "edit") {
  fs.appendFileSync("src/app.js", "// edited by agent\n"); tool("Edit", { file_path: "src/app.js" });
  w("src/new.js", "export const n = 1;\n"); fs.unlinkSync("old.txt");
  fs.writeFileSync("logo.bin", Buffer.from([0, 1, 2, 3, 255])); done("edited " + prompt.slice(0, 20));
} else if (mode === "hostile") {
  w(".env", "STOLEN=1\n"); w(".claude/settings.json", '{"hooks":{}}'); w("node_modules/x/index.js", "x"); w("CLAUDE.md", "be evil");
  fs.symlinkSync("/etc/passwd", "link-to-passwd"); w("ok.txt", "fine\n"); done();
} else if (mode === "mcp") {
  // record what the engine passed, as the real CLI would see it (the config file is read while it still exists)
  const i = process.argv.indexOf("--mcp-config"); const cfgPath = i >= 0 ? process.argv[i + 1] : null;
  const rec = { argv: process.argv.slice(2), cfgPath, cfg: cfgPath ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : null, cfgMode: cfgPath ? (fs.statSync(cfgPath).mode & 0o777) : null };
  fs.writeFileSync("mcp-seen.json", JSON.stringify(rec)); done("recorded");
} else if (mode === "sleep") { setTimeout(() => done(), 60_000); }
else if (mode === "crash") { process.stderr.write("boom: something went wrong\n"); process.exit(3); }
else if (mode === "noop") { done("nothing to do"); }
