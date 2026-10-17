import { describe, expect, it } from "vitest";
import { gzipSync, zipSync, strToU8 } from "fflate";
import { ArchiveError, boundedGunzip, readArchive, readTar, readZip, safeEntryPath, stripCommonRoot } from "../src/analyze/archive";

function tar(files: Record<string, string>, extra: { name: string; type: string; body?: string }[] = []) {
  const blocks: Uint8Array[] = [];
  const mk = (name: string, body: Uint8Array, type = "0") => {
    const h = new Uint8Array(512);
    h.set(strToU8(name).subarray(0, 100), 0);
    h.set(strToU8(body.length.toString(8).padStart(11, "0") + "\0"), 124);
    h[156] = type.charCodeAt(0);
    h.set(strToU8("ustar\0"), 257);
    blocks.push(h);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    blocks.push(padded);
  };
  for (const [n, b] of Object.entries(files)) mk(n, strToU8(b));
  for (const e of extra) mk(e.name, strToU8(e.body ?? ""), e.type);
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

describe("safeEntryPath", () => {
  it.each(["../evil", "a/../../evil", "/etc/passwd", "C:/win", "C:\\win\\x", "a\0b"])("rejects %s", (p) => expect(safeEntryPath(p)).toBeNull());
  it("normalises", () => expect(safeEntryPath("./a//b/./c.txt")).toBe("a/b/c.txt"));
});

describe("readZip", () => {
  it("reads normal archives and drops zip-slip entries", () => {
    const zip = zipSync({ "ok/a.txt": strToU8("hi"), "../../evil.txt": strToU8("x"), "/abs.txt": strToU8("y") });
    const r = readZip(zip);
    expect(r.entries.map((e) => e.path)).toEqual(["ok/a.txt"]);
    expect(r.skipped.join()).toMatch(/unsafe path/);
  });
  it("refuses a zip bomb by declared size BEFORE inflating", () => {
    const zip = zipSync({ "big.bin": new Uint8Array(30_000_000) }); // compresses to ~30KB
    const r = readZip(zip, { maxEntryBytes: 1_000_000 });
    expect(r.entries).toHaveLength(0);
    expect(r.skipped.join()).toMatch(/exceeds per-entry cap|ratio/);
  });
  it("enforces the total budget", () => {
    const zip = zipSync({ a: new Uint8Array(600_000).fill(1), b: new Uint8Array(600_000).fill(2) });
    const r = readZip(zip, { maxTotalBytes: 1_000_000, maxRatio: 1e9 });
    expect(r.entries).toHaveLength(1);
    expect(r.skipped.join()).toMatch(/budget/);
  });
  it("enforces the entry-count limit", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.txt`] = strToU8("x");
    expect(readZip(zipSync(files), { maxEntries: 5 }).entries).toHaveLength(5);
  });
  it("throws a typed error on garbage", () => expect(() => readZip(new Uint8Array([1, 2, 3, 4]))).toThrow(ArchiveError));
});

describe("tar / gzip", () => {
  it("reads tar, rejects traversal, ignores symlinks", () => {
    const r = readTar(tar({ "repo/a.ts": "export {}", "../../etc/x": "bad" }, [{ name: "repo/link", type: "2" }]));
    expect(r.entries.map((e) => e.path)).toEqual(["repo/a.ts"]);
    expect(r.skipped.join()).toMatch(/unsafe path/);
    expect(r.skipped.join()).toMatch(/links are not followed/);
  });
  it("reads tgz via readArchive and strips the common root", () => {
    const r = readArchive(gzipSync(tar({ "proj-main/a.txt": "a", "proj-main/src/b.txt": "b" })), "proj.tar.gz");
    expect(r.format).toBe("tgz");
    expect(stripCommonRoot(r.entries).map((e) => e.path).sort()).toEqual(["a.txt", "src/b.txt"]);
  });
  it("aborts a gzip bomb while streaming", () => {
    const bomb = gzipSync(new Uint8Array(50_000_000));
    expect(bomb.length).toBeLessThan(100_000);
    expect(() => boundedGunzip(bomb, 5_000_000)).toThrow(/exceeds budget/);
  });
  it("rejects unknown formats", () => expect(() => readArchive(new Uint8Array(600).fill(7))).toThrow(/Unrecognised/));
});
