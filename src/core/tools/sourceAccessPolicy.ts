import { normalizePublicSourceDomain, type SourceAccessPolicy } from "../../shared/kernel/sourceAccessPolicy.js";

export type { SourceAccessPolicy } from "../../shared/kernel/sourceAccessPolicy.js";

export interface SourceAccessDecision {
  allowed: boolean;
  canonicalUrl?: string;
  reason?: string;
}

export class SourceAccessPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceAccessPolicyError";
  }
}

export function evaluateSourceAccess(policy: SourceAccessPolicy, rawUrl: string): SourceAccessDecision {
  const canonicalUrl = canonicalHttpUrl(rawUrl);
  if (!canonicalUrl) return { allowed: false, reason: "Source access requires a valid HTTP(S) URL." };
  const hostname = new URL(canonicalUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isInternalHostname(hostname) || isPrivateAddressLiteral(hostname)) {
    return { allowed: false, canonicalUrl, reason: `Source access rejects private or internal host: ${hostname}` };
  }
  if (policy.mode === "offline") return { allowed: false, canonicalUrl, reason: "Source access is offline for this job." };
  if (policy.mode === "allowlist") {
    const invalidUrl = policy.urls.find((url) => !canonicalHttpUrl(url));
    if (invalidUrl) {
      return { allowed: false, canonicalUrl, reason: `Job allowlist contains an invalid HTTP(S) URL: ${invalidUrl}` };
    }
    const allowed = new Set(policy.urls.map(canonicalHttpUrl).filter((url): url is string => Boolean(url)));
    return allowed.has(canonicalUrl)
      ? { allowed: true, canonicalUrl }
      : { allowed: false, canonicalUrl, reason: `URL is outside the job allowlist: ${canonicalUrl}` };
  }
  if (!policy.allowedDomains.length) return { allowed: true, canonicalUrl };
  for (const domain of policy.allowedDomains) {
    const normalized = normalizePublicSourceDomain(domain);
    if (!normalized) {
      return { allowed: false, canonicalUrl, reason: `Job discovery policy contains an invalid public domain: ${domain}` };
    }
    if (normalized && (hostname === normalized || hostname.endsWith(`.${normalized}`))) return { allowed: true, canonicalUrl };
  }
  return { allowed: false, canonicalUrl, reason: `URL host is outside the job discovery domains: ${hostname}` };
}

export function assertSourceAccess(policy: SourceAccessPolicy, rawUrl: string): string {
  const decision = evaluateSourceAccess(policy, rawUrl);
  if (!decision.allowed || !decision.canonicalUrl) throw new SourceAccessPolicyError(decision.reason ?? "Source access denied.");
  return decision.canonicalUrl;
}

export function sourceDiscoveryAllowed(policy: SourceAccessPolicy): boolean {
  return policy.mode === "discovery";
}

export function isValidPublicSourceDomain(value: string): boolean {
  return normalizePublicSourceDomain(value) !== undefined;
}

export function canonicalHttpUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function isInternalHostname(value: string): boolean {
  return value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal");
}

function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateAddressLiteral(value: string): boolean {
  if (isPrivateIpv4(value)) return true;
  if (!value.includes(":")) return false;
  return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/i.test(value) || value.startsWith("ff");
}
