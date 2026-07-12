import { describe, expect, it, vi } from "vitest";
import { PublicUrlPolicy } from "../tools/publicUrlPolicy.js";
import type { Route } from "playwright";
import { assertPublicNavigationUrl, installBrowserNetworkPolicy } from "./browserNetworkPolicy.js";

describe("browser public URL boundary", () => {
  it("accepts a public navigation after DNS validation", async () => {
    const policy = new PublicUrlPolicy({ resolveHostAddresses: async () => ["93.184.216.34"] });
    await expect(assertPublicNavigationUrl(policy, "https://example.com/paper")).resolves.toBe("https://example.com/paper");
  });

  it.each(["http://127.0.0.1/admin", "http://[::1]/admin", "http://169.254.169.254/latest/meta-data"])("rejects internal navigation %s", async (url) => {
    const policy = new PublicUrlPolicy({ resolveHostAddresses: vi.fn() });
    await expect(assertPublicNavigationUrl(policy, url)).rejects.toThrow(/blocked internal/);
  });

  it("rejects DNS rebinding to a private address", async () => {
    const policy = new PublicUrlPolicy({ resolveHostAddresses: async () => ["10.0.0.8"] });
    await expect(assertPublicNavigationUrl(policy, "https://research.example/paper")).rejects.toThrow("DNS resolved");
  });

  it("intercepts redirect and subresource requests and aborts private destinations", async () => {
    let handler: ((route: Route) => Promise<void>) | undefined;
    const policy = new PublicUrlPolicy({ resolveHostAddresses: async () => ["93.184.216.34"] });
    await installBrowserNetworkPolicy(
      {
        async route(_pattern, next) {
          handler = next;
        }
      },
      policy
    );
    const continueRequest = vi.fn(async () => undefined);
    const abortRequest = vi.fn(async () => undefined);
    await handler?.({
      request: () => ({ url: () => "http://10.0.0.9/private" }),
      continue: continueRequest,
      abort: abortRequest
    } as unknown as Route);
    expect(abortRequest).toHaveBeenCalledWith("blockedbyclient");
    expect(continueRequest).not.toHaveBeenCalled();
  });

  it("applies an allowlist source policy to third-party subresources", async () => {
    let handler: ((route: Route) => Promise<void>) | undefined;
    const policy = new PublicUrlPolicy({ resolveHostAddresses: async () => ["93.184.216.34"] });
    await installBrowserNetworkPolicy(
      {
        async route(_pattern, next) {
          handler = next;
        }
      },
      policy,
      { mode: "allowlist", urls: ["https://example.com/paper"] }
    );
    const continueRequest = vi.fn(async () => undefined);
    const abortRequest = vi.fn(async () => undefined);
    await handler?.({
      request: () => ({ url: () => "https://tracker.example/pixel", isNavigationRequest: () => false }),
      continue: continueRequest,
      abort: abortRequest
    } as unknown as Route);
    expect(abortRequest).toHaveBeenCalledWith("blockedbyclient");
    expect(continueRequest).not.toHaveBeenCalled();
  });
});
