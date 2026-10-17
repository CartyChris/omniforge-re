import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { inspectBinary, inspectPath, inspectZipPackage, parseAsar, parseXmlPlist, readAsarFiles, sniffKind } from "../src/bridge/package";
import { investigateSource } from "@omniforge/core";

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-pkg-")); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function macho64(cpu: number, filetype: number, dylibs: string[], opts: { signed?: boolean; uuid?: boolean } = {}) {
  const cmds: Buffer[] = [];
  for (const d of dylibs) { const name = Buffer.from(d + "\0"); const size = Math.ceil((24 + name.length) / 8) * 8; const b = Buffer.alloc(size); b.writeUInt32LE(0xc, 0); b.writeUInt32LE(size, 4); b.writeUInt32LE(24, 8); name.copy(b, 24); cmds.push(b); }
  if (opts.signed) { const b = Buffer.alloc(16); b.writeUInt32LE(0x1d, 0); b.writeUInt32LE(16, 4); cmds.push(b); }
  if (opts.uuid) { const b = Buffer.alloc(24); b.writeUInt32LE(0x1b, 0); b.writeUInt32LE(24, 4); for (let i = 0; i < 16; i++) b[8 + i] = i; cmds.push(b); }
  const body = Buffer.concat(cmds); const h = Buffer.alloc(32);
  h.writeUInt32LE(0xfeedfacf, 0); h.writeUInt32LE(cpu, 4); h.writeUInt32LE(0, 8); h.writeUInt32LE(filetype, 12); h.writeUInt32LE(cmds.length, 16); h.writeUInt32LE(body.length, 20);
  return Buffer.concat([h, body, Buffer.from("see https://api.example.com/v1/users and /Library/Application Support/Acme and dev@acme.io libfoo.dylib\0")]);
}
function asar(files: Record<string, string>) {
  const entries: Record<string, any> = {}; let off = 0; const chunks: Buffer[] = [];
  for (const [n, c] of Object.entries(files)) { const b = Buffer.from(c); entries[n] = { size: b.length, offset: String(off) }; off += b.length; chunks.push(b); }
  const json = Buffer.from(JSON.stringify({ files: entries }));
  const pad = (4 - (json.length % 4)) % 4; const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0); head.writeUInt32LE(json.length + pad + 8, 4); head.writeUInt32LE(json.length + pad + 4, 8); head.writeUInt32LE(json.length, 12);
  return Buffer.concat([head, json, Buffer.alloc(pad), ...chunks]);
}
const PLIST = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist><plist version="1.0"><dict><key>CFBundleName</key><string>Acme &amp; Co</string><key>CFBundleIdentifier</key><string>com.acme.app</string><key>CFBundleShortVersionString</key><string>2.1.0</string><key>CFBundleExecutable</key><string>Acme</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>NSCameraUsageDescription</key><string>Video calls</string><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>acme</string></array></dict></array><key>LSUIElement</key><true/><key>Build</key><integer>42</integer></dict></plist>`;

describe("binary header parsing", () => {
  it("Mach-O: arch, file type, dylibs, signature, UUID and URLs/paths in strings", async () => {
    const b = macho64(0x0100000c, 2, ["/usr/lib/libSystem.B.dylib", "@rpath/Sparkle.framework/Sparkle"], { signed: true, uuid: true });
    expect(sniffKind(b)).toBe("macho");
    const i = await inspectBinary("Acme", b);
    expect(i).toMatchObject({ format: "Mach-O", architectures: ["arm64"], fileType: "executable", bits: 64 });
    expect(i.extra).toMatchObject({ dylibs: ["/usr/lib/libSystem.B.dylib", "@rpath/Sparkle.framework/Sparkle"], codeSignaturePresent: true, encrypted: false, uuid: "000102030405060708090a0b0c0d0e0f" });
    expect(i.strings!.urls).toContain("https://api.example.com/v1/users");
    expect(i.strings!.emails).toContain("dev@acme.io");
    expect(i.strings!.paths.join()).toContain("/Library/Application");
    expect(i.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("Mach-O universal lists every slice", async () => {
    const fat = Buffer.alloc(8 + 40); fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(2, 4); fat.writeUInt32BE(0x01000007, 8); fat.writeUInt32BE(0x0100000c, 28);
    expect(await inspectBinary("fat", fat)).toMatchObject({ kind: "macho-universal", architectures: ["x86_64", "arm64"] });
  });
  it("real ELF binaries on this machine", async () => {
    const ls = fs.readFileSync("/bin/ls");
    const i = await inspectBinary("ls", new Uint8Array(ls));
    expect(i).toMatchObject({ kind: "elf", format: "ELF", bits: 64 });
    expect(i.architectures[0]).toMatch(/x86_64|aarch64/);
    expect(i.sections).toBeGreaterThan(5);
    expect(i.strings!.libraries.some((l) => /libc|libselinux/.test(l))).toBe(true);
  });
  it("PE and .NET detection (CLR data directory)", async () => {
    const pe = (clr: boolean) => { const b = Buffer.alloc(0x400); b.write("MZ", 0); b.writeUInt32LE(0x80, 0x3c); b.write("PE\0\0", 0x80, "latin1"); b.writeUInt16LE(0x8664, 0x84); b.writeUInt16LE(3, 0x86); b.writeUInt32LE(1700000000, 0x88); b.writeUInt16LE(0x2022, 0x96); b.writeUInt16LE(0x20b, 0x98); if (clr) b.writeUInt32LE(0x2008, 0x98 + 112 + 14 * 8); return b; };
    expect(await inspectBinary("a.exe", pe(false))).toMatchObject({ kind: "pe", format: "PE (Windows)", architectures: ["x86_64"], bits: 64, sections: 3, fileType: "DLL" });
    const dn = await inspectBinary("a.dll", pe(true));
    expect(dn.kind).toBe("dotnet");
    expect(dn.notes.join()).toMatch(/inspect-managed-members/);
  });
  it("WebAssembly: sections, imports and exports", async () => {
    // (module (import "env" "log" (func (param i32))) (func $f) (export "run" (func $f)))
    const wasm = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 5, 1, 0x60, 1, 0x7f, 0, 2, 11, 1, 3, 0x65, 0x6e, 0x76, 3, 0x6c, 0x6f, 0x67, 0, 0, 3, 2, 1, 0, 7, 7, 1, 3, 0x72, 0x75, 0x6e, 0, 1, 10, 4, 1, 2, 0, 0x0b]);
    const i = await inspectBinary("m.wasm", wasm);
    expect(i).toMatchObject({ kind: "wasm", architectures: ["wasm32"] });
    expect(i.extra).toMatchObject({ imports: ["env.log"], exports: ["run"] });
  });
  it("is honest about unrecognised data", async () => {
    const i = await inspectBinary("blob", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(i.kind).toBe("unknown");
    expect(i.notes.join()).toMatch(/Unrecognised/);
  });
});

describe("ASAR and plist", () => {
  it("parses ASAR, recovers files byte-for-byte, and skips unsafe paths / unpacked files", () => {
    const a = asar({ "main.js": "console.log('hi')", "package.json": '{"main":"main.js"}', "lib/util.js": "module.exports=1" });
    expect(sniffKind(a)).toBe("asar");
    expect(parseAsar(a).entries.map((e) => e.path).sort()).toEqual(["lib/util.js", "main.js", "package.json"]);
    const r = readAsarFiles(a);
    expect(Buffer.from(r.files.find((f) => f.path === "main.js")!.data).toString()).toBe("console.log('hi')");
    const evil = asar({ "../../escape.js": "x", "ok.js": "1" });
    expect(readAsarFiles(evil).skipped.join()).toMatch(/unsafe path/);
    expect(readAsarFiles(evil).files.map((f) => f.path)).toEqual(["ok.js"]);
  });
  it("parses XML plists incl. nesting, booleans, numbers and entities", () => {
    const p = parseXmlPlist(PLIST)!;
    expect(p).toMatchObject({ CFBundleName: "Acme & Co", CFBundleIdentifier: "com.acme.app", LSUIElement: true, Build: 42 });
    expect((p.CFBundleURLTypes as any)[0].CFBundleURLSchemes).toEqual(["acme"]);
    expect(parseXmlPlist("not a plist")).toBeNull();
  });
});

describe("zip-based packages", () => {
  it("APK: dex count, ABIs, and the honest binary-XML limitation", async () => {
    const r = await inspectZipPackage("a.apk", zipSync({ "AndroidManifest.xml": new Uint8Array([3, 0, 8, 0]), "classes.dex": strToU8("dex"), "classes2.dex": strToU8("dex"), "lib/arm64-v8a/libx.so": strToU8("so"), "lib/x86_64/libx.so": strToU8("so"), "resources.arsc": strToU8("r") }));
    expect(r.kind).toBe("apk");
    expect(r.summary[0]).toMatch(/2 dex file\(s\), native ABIs: arm64-v8a, x86_64/);
    expect(r.limitations.join()).toMatch(/binary XML/);
  });
  it("IPA: reads Info.plist, warns about FairPlay", async () => {
    const r = await inspectZipPackage("a.ipa", zipSync({ "Payload/Acme.app/Info.plist": strToU8(PLIST), "Payload/Acme.app/Acme": strToU8("bin") }));
    expect(r.kind).toBe("ipa");
    expect(r.details).toMatchObject({ bundleId: "com.acme.app", version: "2.1.0" });
    expect(r.limitations.join()).toMatch(/FairPlay/);
  });
  it("JAR main class, Chrome extension permissions, nested ASAR sources", async () => {
    const jar = await inspectZipPackage("a.jar", zipSync({ "META-INF/MANIFEST.MF": strToU8("Manifest-Version: 1.0\nMain-Class: com.acme.Main\n"), "com/acme/Main.class": strToU8("\xca\xfe") }));
    expect(jar).toMatchObject({ kind: "jar", details: { mainClass: "com.acme.Main" } });
    const crx = await inspectZipPackage("x.crx", zipSync({ "manifest.json": strToU8(JSON.stringify({ name: "Ext", version: "1.0", manifest_version: 3, permissions: ["tabs"], host_permissions: ["https://*/*"] })) }));
    expect(crx.kind).toBe("crx");
    expect(crx.summary[0]).toMatch(/Ext.*tabs, https:\/\/\*\/\*/);
    const withAsar = await inspectZipPackage("app.zip", zipSync({ "resources/app.asar": new Uint8Array(asar({ "main.js": "require('electron')" })) }));
    expect(withAsar.files.map((f) => f.path)).toContain("resources/app.asar/main.js");
  });
  it("applies zip-bomb limits", async () => {
    const r = await inspectZipPackage("b.zip", zipSync({ "big.bin": new Uint8Array(70_000_000) }));
    expect(r.limitations.join()).toMatch(/skipped by safety limits/);
  }, 30_000);
});

describe("app bundles from disk", () => {
  it("inspects a mock Electron .app: Info.plist, frameworks, universal executable, ASAR sources — and feeds source analysis", async () => {
    const app = path.join(tmp, "Acme.app");
    fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true }); fs.mkdirSync(path.join(app, "Contents/Frameworks/Electron Framework.framework"), { recursive: true }); fs.mkdirSync(path.join(app, "Contents/Frameworks/Sparkle.framework"), { recursive: true }); fs.mkdirSync(path.join(app, "Contents/Resources"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents/Info.plist"), PLIST);
    fs.writeFileSync(path.join(app, "Contents/MacOS/Acme"), macho64(0x0100000c, 2, ["/usr/lib/libSystem.B.dylib"], { signed: true }));
    fs.writeFileSync(path.join(app, "Contents/Resources/app.asar"), asar({ "main.js": "const {app}=require('electron');fetch('https://api.acme.io/v1/me')", "package.json": JSON.stringify({ name: "acme", main: "main.js", dependencies: { electron: "30" } }) }));
    fs.symlinkSync("/etc", path.join(app, "Contents/Resources/escape")); // must not be followed
    const r = await inspectPath(app);
    expect(r.kind).toBe("app-bundle");
    expect(r.details.info).toMatchObject({ name: "Acme & Co", identifier: "com.acme.app", version: "2.1.0", minimumSystemVersion: "12.0", usageDescriptions: ["NSCameraUsageDescription"] });
    expect(r.details.stack).toEqual(expect.arrayContaining(["Electron", "Sparkle updater"]));
    expect((r.details.executable as any)).toMatchObject({ format: "Mach-O", architectures: ["arm64"] });
    expect(r.files.map((f) => f.path).sort()).toEqual(["main.js", "package.json"]);
    expect((r.details.tree as string[]).some((t) => t.includes("escape"))).toBe(false);
    expect(r.summary.join(" ")).toMatch(/Electron app\.asar: 2 source file/);
    const inv = await investigateSource("Acme", r.files, { kind: "files", origin: app });
    expect(inv.technologies.map((t) => t.name)).toContain("Electron");
    expect(inv.endpoints.map((e) => e.url)).toContain("https://api.acme.io/v1/me");
  });
  it("inspectPath routes files by content, not extension", async () => {
    const f = path.join(tmp, "renamed.txt"); fs.writeFileSync(f, macho64(0x0100000c, 6, []));
    expect((await inspectPath(f)).kind).toBe("macho");
    const d = path.join(tmp, "plain"); fs.mkdirSync(d);
    expect((await inspectPath(d)).kind).toBe("directory");
  });
});
