import { describe, expect, it, vi } from "vitest";
import { BoundedHttpClient, type PublicHttpUrlPolicy } from "./boundedHttpClient.js";
import { JobSourceAccessPolicy } from "./jobSourceAccessPolicy.js";

const canonicalPublicPolicy: PublicHttpUrlPolicy = {
  assertPublicHttpUrl: async (value) => new URL(value).toString()
};

describe("JobSourceAccessPolicy redirects", () => {
  it("uses a bounded HEAD request with the AetherOps user agent for resource checks", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(25 * 1024 * 1024) } })
    ) as typeof fetch;
    const client = new BoundedHttpClient({ fetchImpl, publicUrlPolicy: canonicalPublicPolicy, maxBytes: 1024 });

    const result = await client.head("https://example.test/paper.pdf", {}, { accept: "application/pdf" });

    expect(result.status).toBe(200);
    expect(result.bytes).toHaveLength(0);
    const requestInit = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(requestInit.method).toBe("HEAD");
    expect(new Headers(requestInit.headers).get("user-agent")).toBe("AetherOps/0.2 research client");
    expect(new Headers(requestInit.headers).get("accept")).toBe("application/pdf");
  });

  it("audits every redirect decision without persisting credentials or query values", async () => {
    const audits: Array<{ url: string; redirectChain: string[]; policyDecision: string }> = [];
    const fetchImpl = vi.fn(async (value: string | URL | Request) =>
      String(value).includes("/start")
        ? new Response(null, { status: 302, headers: { location: "https://example.test/final?token=redirect-secret" } })
        : new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })
    ) as typeof fetch;
    const client = new BoundedHttpClient({
      fetchImpl,
      publicUrlPolicy: canonicalPublicPolicy,
      onNetworkAudit: (audit) => audits.push(audit)
    });

    await client.request("https://user:password@example.test/start?api_key=request-secret");

    expect(audits).toHaveLength(2);
    expect(audits[1]?.redirectChain).toHaveLength(2);
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("request-secret");
    expect(serialized).not.toContain("redirect-secret");
    expect(audits.every((audit) => audit.policyDecision === "allowed")).toBe(true);
  });

  it("validates the initial URL and every redirect hop against the job allowlist", async () => {
    const fetchImpl = vi.fn(async (value: string | URL | Request) => {
      const url = String(value);
      if (url === "https://example.test/start") {
        return new Response(null, { status: 302, headers: { location: "https://example.test/final" } });
      }
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    const client = new BoundedHttpClient({
      fetchImpl,
      publicUrlPolicy: new JobSourceAccessPolicy(
        { mode: "allowlist", urls: ["https://example.test/start", "https://example.test/final"] },
        canonicalPublicPolicy
      )
    });

    const result = await client.request("https://example.test/start");

    expect(result.url).toBe("https://example.test/final");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects an out-of-policy redirect before issuing the next request", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://outside.test/final" } })) as typeof fetch;
    const client = new BoundedHttpClient({
      fetchImpl,
      publicUrlPolicy: new JobSourceAccessPolicy({ mode: "allowlist", urls: ["https://example.test/start"] }, canonicalPublicPolicy)
    });

    await expect(client.request("https://example.test/start")).rejects.toThrow(/outside the job allowlist/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
