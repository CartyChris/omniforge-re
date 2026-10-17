import { describe, expect, it } from "vitest";
import { BlockedUrlError, privateIpReason, validateUrl, validateUrlResolved } from "../src/net/ssrf";

describe("validateUrl", () => {
  const blocked = [
    "http://localhost/", "http://127.0.0.1/", "http://127.1.2.3:8080/", "http://10.0.0.5/", "http://172.16.0.1/", "http://172.31.255.255/",
    "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/", "http://0.0.0.0/", "http://100.64.0.1/", "http://[::1]/",
    "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[fe80::1]/", "http://[fd00::1]/", "http://[64:ff9b::a00:1]/",
    "http://metadata.google.internal/", "http://foo.internal/", "http://printer.local/", "http://intranet/", "ftp://example.com/", "file:///etc/passwd",
    "javascript:alert(1)", "http://user:pw@example.com/", "http://example.com:6379/", "http://example.com:22/", "gopher://example.com/",
  ];
  for (const u of blocked) it(`blocks ${u}`, () => expect(() => validateUrl(u)).toThrow(BlockedUrlError));

  const allowed = ["https://example.com/", "http://example.org:8080/x?y=1", "https://sub.domain.co.uk/path", "http://8.8.8.8/", "https://[2606:4700:4700::1111]/"];
  for (const u of allowed) it(`allows ${u}`, () => expect(validateUrl(u).protocol).toMatch(/^https?:$/));

  it("treats decimal/hex/octal IPv4 forms via WHATWG normalisation", () => {
    // new URL() canonicalises these to 127.0.0.1, which must then be blocked.
    for (const u of ["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/"]) expect(() => validateUrl(u)).toThrow(BlockedUrlError);
  });
  it("honours allowPrivate for local desktop mode", () => {
    expect(validateUrl("http://localhost:3000/", { allowPrivate: true }).hostname).toBe("localhost");
  });
});

describe("validateUrlResolved", () => {
  it("blocks hostnames that resolve to private addresses (DNS rebinding style)", async () => {
    await expect(validateUrlResolved("https://evil.example.com/", { resolver: async () => ["93.184.216.34", "10.0.0.7"] })).rejects.toThrow(/10\.0\.0\.7/);
  });
  it("allows hostnames resolving only to public addresses", async () => {
    const u = await validateUrlResolved("https://ok.example.com/", { resolver: async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] });
    expect(u.hostname).toBe("ok.example.com");
  });
  it("fails closed when DNS fails", async () => {
    await expect(validateUrlResolved("https://nx.example.com/", { resolver: async () => { throw new Error("ENOTFOUND"); } })).rejects.toThrow(/DNS/);
  });
});

describe("privateIpReason", () => {
  it("classifies mapped v4-in-v6", () => expect(privateIpReason("::ffff:192.168.0.1")).toMatch(/private/));
  it("passes public", () => expect(privateIpReason("1.1.1.1")).toBeNull());
});
