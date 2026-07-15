import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ResearchLoopStep } from "../../../core/shared/types.js";
import { PublicUrlPolicy } from "../tools/publicUrlPolicy.js";
import { BackgroundBrowserRuntime } from "./backgroundBrowserRuntime.js";

describe("BackgroundBrowserRuntime verified transport", () => {
  it("collects a loopback fixture through Chromium and the verified proxy", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><head><title>Verified browser fixture</title></head><body>proxy-bound evidence</body></html>");
    });
    const dataRoot = mkdtempSync(join(tmpdir(), "aetherops-browser-"));
    const resolver = vi.fn(async () => ["127.0.0.1"]);
    const runtime = new BackgroundBrowserRuntime(dataRoot, new PublicUrlPolicy({ allowLoopback: true, resolveHostAddresses: resolver }));
    try {
      await listen(server);
      const port = (server.address() as AddressInfo).port;
      const url = `http://browser.test:${port}/paper`;

      const pages = await runtime.collect({
        project: {
          id: "browser-proxy-integration",
          goal: "Verify browser transport",
          topic: "verified proxy",
          scope: "loopback integration",
          budget: "short",
          autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: true, allowCodeExecution: false },
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z",
          currentStep: ResearchLoopStep.ExecuteTools,
          status: "running",
          projectRoot: join(dataRoot, "project")
        },
        query: "",
        urls: [url],
        settings: { enabled: true, mode: "background", maxPages: 1, timeoutMs: 10_000, captureScreenshots: false },
        sourceAccess: { mode: "allowlist", urls: [url] }
      });

      expect(pages).toEqual([{ url, title: "Verified browser fixture", text: "proxy-bound evidence" }]);
      expect(resolver.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      await runtime.dispose();
      await closeServer(server);
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 30_000);
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
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
