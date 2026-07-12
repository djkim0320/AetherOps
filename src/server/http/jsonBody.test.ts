import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { readJsonBody } from "./jsonBody.js";

describe("JSON request body boundaries", () => {
  it("rejects an oversized declared Content-Length before reading", async () => {
    const request = fakeRequest({ "content-length": "9" });

    await expect(readJsonBody(request, { label: "test", maxBytes: 8 })).rejects.toMatchObject({ status: 413 });
  });

  it("rejects a chunked body once cumulative bytes exceed the limit", async () => {
    const request = fakeRequest({});
    const result = readJsonBody(request, { label: "test", maxBytes: 8 });

    request.write('{"value":');
    request.write("123}");

    await expect(result).rejects.toMatchObject({ status: 413 });
    request.destroy();
  });

  it("accepts a body at the exact byte boundary", async () => {
    const body = Buffer.from('{"x":1}', "utf8");
    const request = fakeRequest({ "content-length": String(body.byteLength) });
    const result = readJsonBody(request, { label: "test", maxBytes: body.byteLength });

    request.end(body);

    await expect(result).resolves.toEqual({ x: 1 });
  });

  it("does not expose invalid UTF-8 bytes in the error", async () => {
    const request = fakeRequest({});
    const result = readJsonBody(request, { label: "secret-label", maxBytes: 100 });

    request.end(Buffer.from([0xff, 0xfe]));

    await expect(result).rejects.toMatchObject({ status: 400, message: "Invalid UTF-8 request body." });
  });
});

function fakeRequest(headers: Record<string, string>): IncomingMessage & PassThrough {
  const stream = new PassThrough() as IncomingMessage & PassThrough;
  Object.defineProperty(stream, "headers", { value: headers, configurable: true });
  return stream;
}
