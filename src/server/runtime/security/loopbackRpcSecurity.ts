import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";

export const rpcTokenHeader = "x-aetherops-rpc-token";
export const rpcTokenCookieName = "aetherops_rpc_token";
export const rpcAuthConfigFileName = "rpc-auth.json";

export interface LoopbackRpcSecurity {
  token: string;
  tokenSource: "env" | "config" | "generated";
}

export interface RpcAuthFailure {
  status: 401 | 403;
  message: string;
}

interface PersistedRpcAuthConfig {
  token?: unknown;
  createdAt?: unknown;
}

interface CorsOptions {
  host: string;
  port: number;
  env?: NodeJS.ProcessEnv;
}

interface TokenOptions {
  dataRoot: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveLoopbackRpcSecurity(options: TokenOptions): LoopbackRpcSecurity {
  const envToken = options.env?.AETHEROPS_RPC_TOKEN?.trim();
  if (envToken) {
    assertUsableToken(envToken, "AETHEROPS_RPC_TOKEN");
    return { token: envToken, tokenSource: "env" };
  }

  const configPath = join(options.dataRoot, rpcAuthConfigFileName);
  if (existsSync(configPath)) {
    const parsed = readRpcAuthConfig(configPath);
    assertUsableToken(parsed.token, configPath);
    return { token: parsed.token, tokenSource: "config" };
  }

  const token = randomBytes(32).toString("base64url");
  writeRpcAuthConfig(configPath, { token, createdAt: new Date().toISOString() });
  return { token, tokenSource: "generated" };
}

export function assertLoopbackHostAllowed(host: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isLoopbackHost(host)) return;
  if (env.AETHEROPS_ALLOW_NON_LOOPBACK_HOST === "true") return;
  throw new Error(`AETHEROPS_HOST must be loopback-only unless AETHEROPS_ALLOW_NON_LOOPBACK_HOST=true is set. Refusing host: ${host}`);
}

export function authenticateRpcRequest(request: IncomingMessage, expectedToken: string): RpcAuthFailure | undefined {
  const presented = extractPresentedToken(request);
  if (!presented) {
    return { status: 401, message: "RPC token is required." };
  }
  if (!constantTimeTokenEqual(presented, expectedToken)) {
    return { status: 403, message: "RPC token is invalid." };
  }
  return undefined;
}

export function setRpcTokenCookie(response: ServerResponse, token: string): void {
  response.setHeader("Set-Cookie", `${rpcTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`);
}

export function addRestrictedCorsHeaders(request: IncomingMessage, response: ServerResponse, options: CorsOptions): boolean {
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", `Content-Type, Authorization, ${rpcTokenHeader}`);

  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  if (!isAllowedCorsOrigin(origin, options)) {
    return false;
  }

  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  appendVaryHeader(response, "Origin");
  return true;
}

export function isAllowedCorsOrigin(origin: string, options: CorsOptions): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return buildAllowedCorsOrigins(options).has(normalized);
}

export function buildAllowedCorsOrigins(options: CorsOptions): Set<string> {
  const env = options.env ?? process.env;
  const origins = new Set<string>();
  for (const port of uniqueNumbers([options.port, Number(env.AETHEROPS_UI_PORT ?? 5180)])) {
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
    origins.add(`http://[::1]:${port}`);
  }

  const hostOrigin = originForHost(options.host, options.port);
  if (hostOrigin) origins.add(hostOrigin);

  for (const explicit of (env.AETHEROPS_UI_ORIGIN ?? "").split(",")) {
    const normalized = normalizeOrigin(explicit.trim());
    if (!normalized) continue;
    if (!isLoopbackOrigin(normalized) && env.AETHEROPS_ALLOW_NON_LOOPBACK_HOST !== "true") {
      throw new Error(`AETHEROPS_UI_ORIGIN must be loopback unless non-loopback hosting is explicitly enabled: ${normalized}`);
    }
    origins.add(normalized);
  }
  return origins;
}

export function isLoopbackHost(host: string): boolean {
  const cleaned = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (cleaned === "localhost" || cleaned === "::1") return true;
  const ipv4 = cleaned.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && octets[0] === 127;
}

function readRpcAuthConfig(configPath: string): { token: string } {
  let parsed: PersistedRpcAuthConfig;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as PersistedRpcAuthConfig;
  } catch (error) {
    throw new Error(`Invalid AetherOps RPC auth config at ${configPath}: ${formatError(error)}`, { cause: error });
  }
  if (typeof parsed.token !== "string") {
    throw new Error(`Invalid AetherOps RPC auth config at ${configPath}: token is required.`);
  }
  return { token: parsed.token };
}

function writeRpcAuthConfig(configPath: string, config: { token: string; createdAt: string }): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, configPath);
  } catch (error) {
    safeRemove(tempPath);
    throw error;
  }
}

function extractPresentedToken(request: IncomingMessage): string | undefined {
  const headerToken = singleHeaderValue(request.headers[rpcTokenHeader]);
  if (headerToken?.trim()) return headerToken.trim();

  const authorization = singleHeaderValue(request.headers.authorization);
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;

  const cookieHeader = singleHeaderValue(request.headers.cookie);
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== rpcTokenCookieName) continue;
    const value = rawValue.join("=");
    return value ? decodeURIComponent(value) : undefined;
  }
  return undefined;
}

function constantTimeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function assertUsableToken(value: unknown, source: string): asserts value is string {
  if (typeof value !== "string" || value.length < 16 || value.length > 1024 || containsControlCharacter(value)) {
    throw new Error(`${source} must contain a non-control RPC token between 16 and 1024 characters.`);
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function normalizeOrigin(origin: string): string | undefined {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    parsed.pathname = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  const parsed = new URL(origin);
  return isLoopbackHost(parsed.hostname);
}

function originForHost(host: string, port: number): string | undefined {
  const cleaned = host.trim();
  if (!cleaned) return undefined;
  if (!isLoopbackHost(cleaned)) return undefined;
  const hostPart = cleaned.includes(":") && !cleaned.startsWith("[") ? `[${cleaned}]` : cleaned;
  return `http://${hostPart}:${port}`;
}

function uniqueNumbers(values: number[]): number[] {
  const output: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0 || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function appendVaryHeader(response: ServerResponse, value: string): void {
  const current = response.getHeader("Vary");
  if (!current) {
    response.setHeader("Vary", value);
    return;
  }
  const parts = Array.isArray(current) ? current.flatMap((item) => String(item).split(",")) : String(current).split(",");
  if (parts.map((part) => part.trim().toLowerCase()).includes(value.toLowerCase())) return;
  response.setHeader("Vary", [...parts.map((part) => part.trim()).filter(Boolean), value].join(", "));
}

function safeRemove(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    return;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
