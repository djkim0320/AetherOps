import type { LookupAddress, LookupOptions } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";

export interface PublicHostAddressResolver {
  resolvePublicHostAddresses(hostname: string): Promise<string[]>;
}

/** Re-resolves and validates a host at socket-connect time, then gives net.connect only the verified IPs. */
export function createVerifiedHttpFetch(resolver: PublicHostAddressResolver, connectTimeoutMs: number): typeof fetch {
  const dispatcher = new Agent({
    connections: 1,
    maxOrigins: 16,
    pipelining: 0,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: Math.min(250, connectTimeoutMs),
    connect: {
      lookup: createVerifiedLookup(resolver),
      timeout: connectTimeoutMs
    }
  });
  return ((input: string | URL | Request, init?: RequestInit) =>
    globalThis.fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: Agent })) as typeof fetch;
}

export function createVerifiedLookup(resolver: PublicHostAddressResolver): LookupFunction {
  return (hostname, options, callback) => {
    void resolver.resolvePublicHostAddresses(hostname).then(
      (addresses) => {
        const candidates = filterFamily(addresses, options);
        if (!candidates.length) {
          callback(addressFamilyError(hostname), "", 0);
        } else if (options.all) {
          callback(null, candidates);
        } else {
          const first = candidates[0];
          callback(null, first.address, first.family);
        }
      },
      (error: unknown) => callback(asLookupError(error), "", 0)
    );
  };
}

function filterFamily(addresses: string[], options: LookupOptions): LookupAddress[] {
  const requestedFamily = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
  return addresses
    .map((address) => ({ address, family: isIP(address) }))
    .filter((candidate) => (requestedFamily === 4 || requestedFamily === 6 ? candidate.family === requestedFamily : candidate.family !== 0));
}

function addressFamilyError(hostname: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`No verified address matched the requested family for ${hostname}.`), { code: "EAI_ADDRFAMILY" });
}

function asLookupError(error: unknown): NodeJS.ErrnoException {
  const failure = error instanceof Error ? error : new Error(String(error));
  return Object.assign(failure, { code: "EACCES" });
}
