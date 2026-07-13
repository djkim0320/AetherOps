import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rpcTokenHeader } from "./runtime/security/loopbackRpcSecurity.js";
import { startWebServer, type WebServerHandle } from "./webServer.js";

const token = "body-limit-test-token-1234567890";
const previousToken = process.env.AETHEROPS_RPC_TOKEN;
let root: string | undefined;
let server: WebServerHandle | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  if (previousToken === undefined) delete process.env.AETHEROPS_RPC_TOKEN;
  else process.env.AETHEROPS_RPC_TOKEN = previousToken;
});

describe("web server body limit response", () => {
  it("returns stable 413 JSON before closing an oversized request connection", async () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-web-body-limit-"));
    process.env.AETHEROPS_RPC_TOKEN = token;
    server = await startWebServer({ port: 0, host: "127.0.0.1", dataRoot: root, appRoot: process.cwd(), installSignalHandlers: false });
    const response = await sendRawHttp(
      server,
      [
        "POST /api/v2/rpc HTTP/1.1",
        `Host: ${server.host}:${server.port}`,
        "Content-Type: application/json",
        `${rpcTokenHeader}: ${token}`,
        "Content-Length: 10000001",
        "Connection: close",
        "",
        "x"
      ].join("\r\n")
    );

    expect(response).toMatch(/^HTTP\/1\.1 413 /);
    expect(response).toMatch(/Connection: close/i);
    expect(response).toContain('"code":"VALIDATION_ERROR"');
    expect(response).toContain('"message":"Request body is too large."');
  });
});

function sendRawHttp(handle: WebServerHandle, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: handle.host, port: handle.port });
    const chunks: Buffer[] = [];
    socket.setTimeout(5_000, () => socket.destroy(new Error("Raw HTTP response timed out.")));
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}
