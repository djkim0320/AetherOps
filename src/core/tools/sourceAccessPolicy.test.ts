import { describe, expect, it } from "vitest";
import { assertSourceAccess, evaluateSourceAccess, sourceDiscoveryAllowed, SourceAccessPolicyError } from "./sourceAccessPolicy.js";

describe("source access policy", () => {
  it("enforces exact canonical URLs in allowlist mode", () => {
    const policy = { mode: "allowlist" as const, urls: ["https://Example.com:443/a#fragment"] };
    expect(assertSourceAccess(policy, "https://example.com/a")).toBe("https://example.com/a");
    expect(() => assertSourceAccess(policy, "https://example.com/b")).toThrow(SourceAccessPolicyError);
    expect(sourceDiscoveryAllowed(policy)).toBe(false);
  });

  it("accepts a canonical host and its subdomains in discovery mode", () => {
    const policy = { mode: "discovery" as const, allowedDomains: ["example.edu"] };
    expect(evaluateSourceAccess(policy, "https://data.example.edu/paper").allowed).toBe(true);
    expect(evaluateSourceAccess(policy, "https://example.com/paper").allowed).toBe(false);
  });

  it("rejects an invalid domain entry instead of treating it as an unrestricted policy", () => {
    expect(evaluateSourceAccess({ mode: "discovery", allowedDomains: ["localhost"] }, "https://example.edu/paper")).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("invalid public domain")
    });
    expect(evaluateSourceAccess({ mode: "discovery", allowedDomains: ["*.example.edu"] }, "https://data.example.edu/paper").allowed).toBe(false);
  });

  it("rejects credentials, wildcard domains, and private/internal literals", () => {
    expect(evaluateSourceAccess({ mode: "discovery", allowedDomains: [] }, "https://user:secret@example.com/").allowed).toBe(false);
    expect(evaluateSourceAccess({ mode: "discovery", allowedDomains: ["*.example.com"] }, "https://a.example.com/").allowed).toBe(false);
    expect(evaluateSourceAccess({ mode: "discovery", allowedDomains: [] }, "http://127.0.0.1/").allowed).toBe(false);
    expect(evaluateSourceAccess({ mode: "discovery", allowedDomains: [] }, "http://[::1]/").allowed).toBe(false);
  });

  it("denies all network URLs in offline mode", () => {
    expect(() => assertSourceAccess({ mode: "offline" }, "https://example.com/")).toThrow(/offline/);
  });
});
