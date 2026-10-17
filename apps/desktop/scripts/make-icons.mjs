// Renders the OmniForge logo to a 1024×1024 PNG (the input of `tauri icon`).
import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src-tauri/icons/source.png");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14172a"/><stop offset="1" stop-color="#0b0d12"/></linearGradient><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b7bff"/><stop offset="1" stop-color="#2dd4bf"/></linearGradient></defs><rect width="1024" height="1024" rx="228" fill="url(#bg)"/><g transform="translate(192 192) scale(10)"><path d="M32 6 54 18.5v27L32 58 10 45.5v-27z" fill="none" stroke="url(#g)" stroke-width="4.5" stroke-linejoin="round"/><path d="M32 6v26m0 0 22-13.5M32 32 10 18.5M32 32v26" stroke="url(#g)" stroke-width="2.5" stroke-linecap="round" opacity=".55"/><circle cx="32" cy="32" r="6.5" fill="url(#g)"/></g></svg>`;
const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
await p.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
await p.screenshot({ path: out, omitBackground: true });
await b.close(); console.log("wrote", out);
