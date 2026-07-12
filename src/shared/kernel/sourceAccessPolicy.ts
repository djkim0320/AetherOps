export type SourceAccessPolicy =
  { mode: "offline" } | { mode: "allowlist"; urls: readonly string[] } | { mode: "discovery"; allowedDomains: readonly string[] };

export function normalizePublicSourceDomain(value: string): string | undefined {
  const domain = value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (!domain || domain.includes(":") || domain.includes("*") || domain.includes("/") || isInternalHostname(domain) || isIpv4Literal(domain)) {
    return undefined;
  }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
    return undefined;
  }
  return domain;
}

export function isValidPublicSourceDomain(value: string): boolean {
  return normalizePublicSourceDomain(value) !== undefined;
}

function isInternalHostname(value: string): boolean {
  return value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal");
}

function isIpv4Literal(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}
