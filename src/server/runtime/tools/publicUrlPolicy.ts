import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal"];

export interface PublicUrlPolicyOptions {
  allowLoopback?: boolean;
  resolveHostAddresses?: (hostname: string) => Promise<string[]>;
}

export class PublicUrlPolicy {
  constructor(private readonly options: PublicUrlPolicyOptions = {}) {}

  canonicalizeHttpUrl(value: string): string | undefined {
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
      parsed.hash = "";
      parsed.protocol = parsed.protocol.toLowerCase();
      parsed.hostname = parsed.hostname.toLowerCase();
      if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
        parsed.port = "";
      }
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  async assertPublicHttpUrl(value: string): Promise<string> {
    const canonical = this.canonicalizeHttpUrl(value);
    if (!canonical) {
      throw new Error(`invalid URL: ${value}`);
    }

    const parsed = new URL(canonical);
    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname) {
      throw new Error(`invalid URL: ${value}`);
    }

    if (hostname === "localhost" || hasBlockedHostSuffix(hostname)) {
      if (!this.options.allowLoopback || !isLoopbackHostname(hostname)) {
        throw new Error(`blocked internal hostname: ${parsed.hostname}`);
      }
    }

    if (isIpLiteral(hostname)) {
      if (isPrivateOrInternalIp(hostname) && !(this.options.allowLoopback && isLoopbackIp(hostname))) {
        throw new Error(`blocked internal IP address: ${parsed.hostname}`);
      }
      return canonical;
    }

    const addresses = await this.resolveHostAddresses(hostname);
    const blocked = firstBlockedAddress(addresses, this.options.allowLoopback ?? false);
    if (blocked) {
      throw new Error(`DNS resolved ${hostname} to blocked internal IP address: ${blocked}`);
    }
    return canonical;
  }

  private async resolveHostAddresses(hostname: string): Promise<string[]> {
    try {
      const resolver = this.options.resolveHostAddresses ?? defaultResolveHostAddresses;
      return await resolver(hostname);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`DNS resolution failed for ${hostname}: ${reason}`, { cause: error });
    }
  }
}

async function defaultResolveHostAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  const addresses: string[] = [];
  for (const record of records) addresses.push(record.address);
  return addresses;
}

function normalizeHostname(value: string): string {
  return value
    .replace(/^\[|\]$/g, "")
    .trim()
    .toLowerCase();
}

function hasBlockedHostSuffix(hostname: string): boolean {
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (hostname.endsWith(suffix)) return true;
  }
  return false;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isIpLiteral(hostname: string): boolean {
  return isIP(hostname) !== 0 || hostname.includes(":");
}

function isLoopbackIp(value: string): boolean {
  const hostname = normalizeHostname(value);
  if (hostname === "127.0.0.1" || hostname === "::1" || hostname === "::" || hostname === "0:0:0:0:0:0:0:1" || hostname === "0:0:0:0:0:0:0:0") {
    return true;
  }
  const mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? hostname.match(/^0:0:0:0:0:ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isLoopbackIp(mapped[1]);
  if (!isIpv4(hostname)) return false;
  const parts = hostname.split(".");
  return Number(parts[0]) === 127;
}

function isPrivateOrInternalIp(value: string): boolean {
  const hostname = normalizeHostname(value);
  if (isLoopbackIp(hostname)) return true;

  const mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? hostname.match(/^0:0:0:0:0:ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateOrInternalIp(mapped[1]);
  if (hostname.includes(":")) return isPrivateOrInternalIpv6(hostname);
  if (!isIpv4(hostname)) return false;

  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;

  const [first, second, third] = parts;
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && second === 18) ||
    (first === 198 && second === 19) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function isPrivateOrInternalIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  if (hostname === "::" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:0" || hostname === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? hostname.match(/^0:0:0:0:0:ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateOrInternalIp(mapped[1]);
  const firstHextet = firstNonEmptyHextet(hostname);
  if (!firstHextet || !/^[0-9a-f]{1,4}$/i.test(firstHextet)) return false;
  const first = Number.parseInt(firstHextet, 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || first === 0 || first === 0xffff;
}

function firstBlockedAddress(addresses: string[], allowLoopback: boolean): string | undefined {
  for (const address of addresses) {
    if (!isPrivateOrInternalIp(address)) continue;
    if (allowLoopback && isLoopbackIp(address)) continue;
    return address;
  }
  return undefined;
}

function firstNonEmptyHextet(hostname: string): string | undefined {
  let start = 0;
  for (let index = 0; index <= hostname.length; index += 1) {
    if (index < hostname.length && hostname[index] !== ":") continue;
    if (index > start) return hostname.slice(start, index);
    start = index + 1;
  }
  return undefined;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return false;
    const numeric = Number(part);
    if (numeric < 0 || numeric > 255) return false;
  }
  return true;
}
