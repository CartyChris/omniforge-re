/**
 * SSRF protection for hosted URL ingestion.
 *
 * Layers:
 *  1. Syntactic URL validation (scheme, credentials, hostnames).
 *  2. IP classification for literals and for every DNS answer.
 *  3. Per-hop re-validation of redirects (redirects are followed manually).
 *  4. (Node only, see ../node.ts) connect-time address filtering, which
 *     closes the DNS-rebinding gap between "resolve" and "connect".
 */

export class BlockedUrlError extends Error {
  constructor(
    message: string,
    public readonly code: "scheme" | "credentials" | "hostname" | "private-ip" | "port" | "invalid" | "dns" | "scope",
  ) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"];
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.azure.com",
  "instance-data",
  "kubernetes.default",
  "kubernetes.default.svc",
]);
const BLOCKED_PORTS = new Set([0, 21, 22, 23, 25, 110, 111, 135, 139, 143, 445, 2375, 2376, 3306, 5432, 6379, 9200, 11211, 27017]);

export function parseIPv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return null;
  return nums;
}

/** Returns a reason string when an IPv4 address is not publicly routable. */
export function privateIPv4Reason(ip: number[]): string | null {
  const [a, b, c] = ip as [number, number, number, number];
  if (a === 0) return "this-network (0.0.0.0/8)";
  if (a === 10) return "private (10.0.0.0/8)";
  if (a === 127) return "loopback (127.0.0.0/8)";
  if (a === 169 && b === 254) return "link-local / cloud metadata (169.254.0.0/16)";
  if (a === 172 && b >= 16 && b <= 31) return "private (172.16.0.0/12)";
  if (a === 192 && b === 168) return "private (192.168.0.0/16)";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT (100.64.0.0/10)";
  if (a === 192 && b === 0 && c === 0) return "IETF protocol assignments (192.0.0.0/24)";
  if (a === 192 && b === 0 && c === 2) return "documentation (192.0.2.0/24)";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking (198.18.0.0/15)";
  if (a === 198 && b === 51 && c === 100) return "documentation (198.51.100.0/24)";
  if (a === 203 && b === 0 && c === 113) return "documentation (203.0.113.0/24)";
  if (a >= 224) return "multicast/reserved (224.0.0.0/3)";
  return null;
}

function expandIPv6(host: string): number[] | null {
  let h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  if (!h.includes(":")) return null;
  const v4 = h.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const ip = parseIPv4(v4[1]!);
    if (!ip) return null;
    h = h.slice(0, -v4[1]!.length) + ((ip[0]! << 8) | ip[1]!).toString(16) + ":" + ((ip[2]! << 8) | ip[3]!).toString(16);
  }
  const parts = h.split("::");
  if (parts.length > 2) return null;
  const hs = parts[0] ? parts[0].split(":") : [];
  const rs = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - hs.length - rs.length;
  if (parts.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...hs, ...Array(parts.length === 2 ? missing : 0).fill("0"), ...rs];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

export function privateIPv6Reason(host: string): string | null {
  const g = expandIPv6(host);
  if (!g) return null;
  if (g.every((x) => x === 0)) return "unspecified (::)";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback (::1)";
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const ip = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
    const r = privateIPv4Reason(ip);
    if (r) return `IPv4-mapped ${r}`;
  }
  // NAT64 64:ff9b::/96 wrapping a private v4
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    const ip = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
    const r = privateIPv4Reason(ip);
    if (r) return `NAT64 ${r}`;
  }
  if ((g[0]! & 0xfe00) === 0xfc00) return "unique-local (fc00::/7)";
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
  if ((g[0]! & 0xffc0) === 0xfec0) return "site-local (fec0::/10)";
  if ((g[0]! & 0xff00) === 0xff00) return "multicast (ff00::/8)";
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "documentation (2001:db8::/32)";
  return null;
}

/** Classify any IP literal. Returns null when it is public. */
export function privateIpReason(ip: string): string | null {
  const v4 = parseIPv4(ip);
  if (v4) return privateIPv4Reason(v4);
  if (ip.includes(":")) return privateIPv6Reason(ip);
  return null;
}

export interface UrlPolicy {
  /** Permit loopback/private targets (desktop local mode, tests). */
  allowPrivate?: boolean;
  /** Extra hostnames always allowed (e.g. a user's explicitly authorized staging host). */
  allowHosts?: string[];
}

/** Synchronous validation that does not require DNS. Throws BlockedUrlError. */
export function validateUrl(input: string, policy: UrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new BlockedUrlError(`Not a valid URL: ${input}`, "invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Only http and https URLs can be analysed (got ${url.protocol})`, "scheme");
  }
  if (url.username || url.password) {
    throw new BlockedUrlError("URLs containing credentials are not accepted", "credentials");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (policy.allowHosts?.includes(host)) return url;
  if (policy.allowPrivate) return url;

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (BLOCKED_PORTS.has(port)) throw new BlockedUrlError(`Port ${port} is not permitted`, "port");
  if (!host) throw new BlockedUrlError("Missing hostname", "hostname");
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BlockedUrlError(`Host "${host}" is an internal name`, "hostname");
  }
  const literal = host.replace(/^\[|\]$/g, "");
  const reason = privateIpReason(literal);
  if (reason) throw new BlockedUrlError(`Address ${literal} is ${reason}`, "private-ip");
  if (!host.includes(".") && !literal.includes(":")) {
    throw new BlockedUrlError(`Single-label host "${host}" is not publicly resolvable`, "hostname");
  }
  return url;
}

export type Resolver = (hostname: string) => Promise<string[]>;

/** Validate URL + every resolved address. */
export async function validateUrlResolved(input: string, policy: UrlPolicy & { resolver?: Resolver } = {}): Promise<URL> {
  const url = validateUrl(input, policy);
  if (policy.allowPrivate || !policy.resolver) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (parseIPv4(host) || host.includes(":")) return url; // literal already checked
  let addrs: string[];
  try {
    addrs = await policy.resolver(host);
  } catch (e) {
    throw new BlockedUrlError(`DNS lookup failed for ${host}: ${(e as Error).message}`, "dns");
  }
  if (!addrs.length) throw new BlockedUrlError(`No DNS records for ${host}`, "dns");
  for (const a of addrs) {
    const r = privateIpReason(a);
    if (r) throw new BlockedUrlError(`${host} resolves to ${a}, which is ${r}`, "private-ip");
  }
  return url;
}
