import type { IncomingMessage } from "node:http";
import { decodeStrictUtf8Chunks } from "../runtime/support/strictUtf8.js";
import { HttpError } from "./response.js";

export interface JsonBodyOptions {
  label: string;
  maxBytes?: number;
}

export async function readJsonBody(request: IncomingMessage, options: JsonBodyOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      bodyBytes += buffer.byteLength;
      if (bodyBytes > (options.maxBytes ?? 10_000_000)) {
        reject(new HttpError(413, "Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        const body = chunks.length ? decodeStrictUtf8Chunks(chunks, options.label) : "";
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        if (error instanceof SyntaxError) {
          reject(new HttpError(400, "Invalid JSON request body."));
          return;
        }
        reject(new HttpError(400, error instanceof Error ? error.message : "Invalid UTF-8 request body."));
      }
    });
    request.on("error", reject);
  });
}
