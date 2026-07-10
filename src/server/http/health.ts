import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { sendJson } from "./response.js";

export interface HealthPayloadOptions {
  port: number;
  startedAt: string;
  version: string;
  dataRoot: string;
}

export function healthPayload(options: HealthPayloadOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ok: true,
    mode: "web",
    port: options.port,
    startedAt: options.startedAt,
    version: options.version
  };
  if (process.env.AETHEROPS_DEBUG_HEALTH === "true") {
    payload.dataRoot = options.dataRoot;
    payload.pid = process.pid;
  }
  return payload;
}

export function sendHealthResponse(response: ServerResponse, payload: Record<string, unknown>): void {
  sendJson(response, 200, payload);
}

export async function readPackageVersion(appRoot: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}
