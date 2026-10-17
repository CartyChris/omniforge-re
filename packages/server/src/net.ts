/**
 * Node networking with connect-time SSRF protection.
 *
 * Validating a hostname before fetching is not enough: DNS can answer
 * differently between the check and the connection (rebinding). This agent
 * resolves the name itself at connect time and refuses to connect to any
 * non-public address, so the address that is checked is the address that is used.
 */
import dns from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { privateIpReason } from "@omniforge/core";

export function createGuardedAgent(o: { allowPrivate?: boolean } = {}) {
  return new Agent({
    connect: {
      lookup(hostname: string, options: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void) {
        dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
          if (err) return cb(err, "", 0);
          const list = addrs as dns.LookupAddress[];
          if (!o.allowPrivate) {
            for (const a of list) {
              const reason = privateIpReason(a.address);
              if (reason) return cb(Object.assign(new Error(`Blocked: ${hostname} resolves to ${a.address} (${reason})`), { code: "EBLOCKED" }), "", 0);
            }
          }
          if ((options as { all?: boolean }).all) return cb(null, list);
          cb(null, list[0]!.address, list[0]!.family);
        });
      },
    },
    headersTimeout: 20_000,
    bodyTimeout: 30_000,
  });
}

export const nodeResolver = async (host: string): Promise<string[]> => (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

export interface NodeNet {
  fetch: typeof fetch;
  dispatcher: unknown;
  resolver: (h: string) => Promise<string[]>;
  allowPrivate: boolean;
}

/** fetch + dispatcher + resolver wired together for core's investigate()/safeFetch(). */
export function nodeNet(o: { allowPrivate?: boolean } = {}): NodeNet {
  const dispatcher = createGuardedAgent(o);
  return {
    fetch: ((input: string, init?: RequestInit) => undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch,
    dispatcher,
    resolver: nodeResolver,
    allowPrivate: !!o.allowPrivate,
  };
}
