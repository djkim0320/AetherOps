import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { inspectListenPort } from "../../scripts/lib/checks.mjs";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("doctor loopback port assessment", () => {
  it("treats port zero as a valid dynamic binding request", async () => {
    await expect(inspectListenPort(0)).resolves.toEqual({ available: true, status: "dynamic" });
  });

  it("distinguishes invalid and occupied ports", async () => {
    await expect(inspectListenPort(1.5)).resolves.toEqual({ available: false, status: "invalid" });
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback test server did not expose a TCP port.");
    await expect(inspectListenPort(address.port)).resolves.toEqual({ available: false, status: "occupied" });
  });
});
