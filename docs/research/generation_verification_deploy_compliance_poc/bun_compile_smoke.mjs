// PoC (2026-10-18): Bun --compile compatibility smoke test of candidate pure-JS/WASM libs.
// bun build --compile t.mjs --external "chromium-bidi/*" --external ajv --external ajv-formats-draft2019 --external ajv/dist/2019 --external xmlbuilder2 --external libxmljs2 --external ajv-formats --outfile tbin
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import looksSame from "looks-same";
import { identifyLicense } from "license-similarity";
import spdxParse from "spdx-expression-parse";
import { initBlazediff, diff as bzDiff } from "@blazediff/core-wasm";
import wasmFile from "@blazediff/core-wasm/wasm/blazediff_bg.wasm" with { type: "file" };
import { Models, Serialize, Spec, Enums } from "@cyclonedx/cyclonedx-library";
import { chromium } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";

const out = {};
const mk = (w, h, f) => { const p = new PNG({ width: w, height: h }); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; const [r, g, b] = f(x, y); p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255; } return p; };
const a = mk(64, 64, () => [255, 255, 255]);
const b = mk(64, 64, (x, y) => (x > 10 && x < 30 && y > 10 && y < 20 ? [255, 0, 0] : [255, 255, 255]));
out.pixelmatch = pixelmatch(a.data, b.data, null, 64, 64, { threshold: 0.1 });
try { await initBlazediff(readFileSync(wasmFile)); out.blazediffWasm = await bzDiff(new Uint8Array(a.data), new Uint8Array(b.data), 64, 64); } catch (e) { out.blazediffWasm = "ERR " + e.message; }
try { const r = await looksSame(PNG.sync.write(a), PNG.sync.write(b), { shouldCluster: true, clustersSize: 5 }); out.looksSame = { equal: r.equal, bounds: r.diffBounds, clusters: (r.diffClusters || []).length }; } catch (e) { out.looksSame = "ERR " + e.message; }
try { out.licenseSimilarity = await identifyLicense("MIT License\n\nCopyright (c) 2026 X\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT."); } catch (e) { out.licenseSimilarity = "ERR " + e.message; }
out.spdx = JSON.stringify(spdxParse("(MIT OR Apache-2.0)"));
try { const bom = new Models.Bom(); bom.metadata.component = new Models.Component(Enums.ComponentType.Application, "demo", { version: "1.0.0" }); const ser = new Serialize.JsonSerializer(new Serialize.JSON.Normalize.Factory(Spec.Spec1dot6)); out.cyclonedx = ser.serialize(bom).length + " bytes JSON"; } catch (e) { out.cyclonedx = "ERR " + e.message; }
try { out.playwrightCore = typeof chromium.launch + " execPath=" + chromium.executablePath(); } catch (e) { out.playwrightCore = "ERR " + e.message; }
out.axePlaywright = typeof AxeBuilder;
console.log(JSON.stringify(out, null, 1));
