import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedHttpClient } from "./boundedHttpClient.js";
import { PublicUrlPolicy } from "./publicUrlPolicy.js";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => closeServer(server)));
  servers.clear();
});

describe("connect-time public address verification", () => {
  it("connects through the verified address without a second OS DNS lookup", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    servers.add(server);
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const resolveHostAddresses = vi.fn(async () => ["127.0.0.1"]);
    const client = new BoundedHttpClient({
      publicUrlPolicy: new PublicUrlPolicy({ allowLoopback: true, resolveHostAddresses }),
      timeoutMs: 1_000
    });

    const result = await client.json<{ ok: boolean }>(`http://verified.test:${port}/result`);

    expect(result.body).toEqual({ ok: true });
    expect(resolveHostAddresses).toHaveBeenCalledTimes(2);
  });

  it("rejects a hostname that changes from public at policy check to private at socket connect", async () => {
    const resolveHostAddresses = vi.fn().mockResolvedValueOnce(["93.184.216.34"]).mockResolvedValueOnce(["127.0.0.1"]);
    const client = new BoundedHttpClient({
      publicUrlPolicy: new PublicUrlPolicy({ resolveHostAddresses }),
      timeoutMs: 1_000
    });

    const error = await client.request("http://rebind.test/resource").catch((caught: unknown) => caught);

    expect(errorMessages(error)).toContain("DNS resolved rebind.test to blocked internal IP address: 127.0.0.1");
    expect(resolveHostAddresses).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed resolver output instead of passing it to the socket", async () => {
    const policy = new PublicUrlPolicy({ resolveHostAddresses: async () => ["not-an-ip"] });

    await expect(policy.assertPublicHttpUrl("https://invalid-answer.test/resource")).rejects.toThrow("DNS returned an invalid IP address");
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function errorMessages(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join(" | ");
}
