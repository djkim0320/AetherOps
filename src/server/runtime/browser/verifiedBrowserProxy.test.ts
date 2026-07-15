import { createServer as createHttpServer, request as requestHttp } from "node:http";
import { connect as connectTcp, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicUrlPolicy } from "../tools/publicUrlPolicy.js";
import { VerifiedBrowserProxy } from "./verifiedBrowserProxy.js";

const proxies = new Set<VerifiedBrowserProxy>();
const servers = new Set<{ close(callback: (error?: Error) => void): unknown }>();

afterEach(async () => {
  await Promise.all([...proxies].map((proxy) => proxy.close()));
  await Promise.all([...servers].map((server) => closeServer(server)));
  proxies.clear();
  servers.clear();
});

describe("VerifiedBrowserProxy", () => {
  it("forwards HTTP through a connect-time verified address", async () => {
    const upstream = createHttpServer((_request, response) => response.end("verified-response"));
    servers.add(upstream);
    await listen(upstream);
    const resolver = vi.fn(async () => ["127.0.0.1"]);
    const proxy = await startProxy(new PublicUrlPolicy({ allowLoopback: true, resolveHostAddresses: resolver }));
    const port = (upstream.address() as AddressInfo).port;

    const response = await requestThroughProxy(proxy.url(), `http://origin.test:${port}/data`);

    expect(response).toMatchObject({ status: 200, body: "verified-response" });
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("blocks CONNECT when DNS changes from public to private before socket connection", async () => {
    const resolver = vi.fn().mockResolvedValueOnce(["93.184.216.34"]).mockResolvedValueOnce(["127.0.0.1"]);
    const proxy = await startProxy(new PublicUrlPolicy({ resolveHostAddresses: resolver }));
    const socket = await connectProxy(proxy.url());

    socket.write("CONNECT rebind.test:443 HTTP/1.1\r\nHost: rebind.test:443\r\n\r\n");
    const header = await readHeader(socket);

    expect(header).toContain("403 Forbidden");
    expect(resolver).toHaveBeenCalledTimes(2);
    socket.destroy();
  });

  it("creates a verified CONNECT tunnel and closes it during idempotent shutdown", async () => {
    const upstream = createTcpServer((socket) => socket.pipe(socket));
    servers.add(upstream);
    await listen(upstream);
    const resolver = vi.fn(async () => ["127.0.0.1"]);
    const proxy = await startProxy(new PublicUrlPolicy({ allowLoopback: true, resolveHostAddresses: resolver }));
    const targetPort = (upstream.address() as AddressInfo).port;
    const socket = await connectProxy(proxy.url());
    socket.write(`CONNECT tunnel.test:${targetPort} HTTP/1.1\r\nHost: tunnel.test:${targetPort}\r\n\r\n`);
    expect(await readHeader(socket)).toContain("200 Connection Established");

    socket.write("probe");
    const [echo] = (await once(socket, "data")) as [Buffer];
    expect(echo.toString("utf8")).toBe("probe");
    const socketClosed = once(socket, "close");
    const firstClose = proxy.close();
    expect(proxy.close()).toBe(firstClose);
    await firstClose;
    await socketClosed;
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});

async function startProxy(policy: PublicUrlPolicy): Promise<VerifiedBrowserProxy> {
  const proxy = await VerifiedBrowserProxy.start({
    policy,
    sourceAccess: { mode: "discovery", allowedDomains: [] },
    timeoutMs: 1_000,
    signal: new AbortController().signal
  });
  proxies.add(proxy);
  return proxy;
}

function listen(server: TcpServer | ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: { close(callback: (error?: Error) => void): unknown }): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function connectProxy(proxyUrl: string): Promise<Socket> {
  const parsed = new URL(proxyUrl);
  const socket = connectTcp({ host: parsed.hostname, port: Number(parsed.port) });
  await once(socket, "connect");
  return socket;
}

function readHeader(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (!received.includes("\r\n\r\n")) return;
      cleanup();
      resolve(received);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function requestThroughProxy(proxyUrl: string, targetUrl: string): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      {
        hostname: proxy.hostname,
        port: Number(proxy.port),
        path: targetUrl,
        method: "GET",
        headers: { host: new URL(targetUrl).host }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    request.once("error", reject);
    request.end();
  });
}
