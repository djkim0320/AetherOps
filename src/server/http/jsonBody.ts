import type { IncomingMessage } from "node:http";
import { decodeStrictUtf8Chunks } from "../runtime/support/strictUtf8.js";
import { HttpError } from "./response.js";

export interface JsonBodyOptions {
  label: string;
  maxBytes?: number;
}

export async function readJsonBody(request: IncomingMessage, options: JsonBodyOptions): Promise<unknown> {
  const maxBytes = options.maxBytes ?? 10_000_000;
  const declaredLength = declaredContentLength(request);
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    throw new HttpError(413, "Request body is too large.");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      request.pause();
      reject(error);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bodyBytes += buffer.byteLength;
      if (bodyBytes > maxBytes) {
        fail(new HttpError(413, "Request body is too large."));
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (settled) return;
      try {
        const body = chunks.length ? decodeStrictUtf8Chunks(chunks, options.label) : "";
        settled = true;
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        if (error instanceof SyntaxError) {
          fail(new HttpError(400, "Invalid JSON request body."));
          return;
        }
        fail(new HttpError(400, "Invalid UTF-8 request body."));
      }
    });
    request.on("error", fail);
  });
}

function declaredContentLength(request: IncomingMessage): number | undefined {
  const value = request.headers["content-length"];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, "Invalid Content-Length header.");
  return parsed;
}
