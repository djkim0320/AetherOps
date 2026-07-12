import childProcess from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const originalFetch = globalThis.fetch;
if (typeof originalFetch === "function") {
  globalThis.fetch = function autonomyOfflineFetch(input, init) {
    assertLoopbackUrl(typeof input === "string" || input instanceof URL ? input : input.url);
    return originalFetch(input, init);
  };
}

patchRequest(http, "request");
patchRequest(http, "get");
patchRequest(https, "request");
patchRequest(https, "get");
patchNet("connect");
patchNet("createConnection");

for (const name of [
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse"
]) {
  if (typeof dns[name] !== "function") continue;
  dns[name] = function blockedDnsLookup() {
    const callback = [...arguments].findLast((value) => typeof value === "function");
    const error = offlineError(`DNS ${name}`);
    if (callback) return process.nextTick(callback, error);
    throw error;
  };
}

const originalLookup = dns.lookup;
dns.lookup = function guardedLookup(hostname) {
  if (loopbackHosts.has(String(hostname).toLowerCase())) return originalLookup.apply(this, arguments);
  const callback = [...arguments].findLast((value) => typeof value === "function");
  const error = offlineError(`DNS lookup for ${hostname}`);
  if (callback) return process.nextTick(callback, error);
  throw error;
};

for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
  const original = childProcess[name];
  childProcess[name] = function guardedProcess(command) {
    if (/(?:^|[\\/])(codex|opencode)(?:\.exe|\.cmd|\.bat)?$/i.test(String(command))) {
      throw offlineError(`process ${command}`);
    }
    return original.apply(this, arguments);
  };
}
syncBuiltinESMExports();

function patchRequest(module, name) {
  const original = module[name];
  module[name] = function guardedRequest(input, options) {
    const candidate = typeof input === "string" || input instanceof URL ? input : urlFromOptions(input ?? options);
    assertLoopbackUrl(candidate);
    return original.apply(this, arguments);
  };
}

function patchNet(name) {
  const original = net[name];
  net[name] = function guardedConnect() {
    const host = connectionHost(arguments);
    if (!loopbackHosts.has(host)) throw offlineError(`socket connection to ${host}`);
    return original.apply(this, arguments);
  };
}

function connectionHost(args) {
  const first = args[0];
  const value = first && typeof first === "object" ? (first.host ?? first.hostname ?? "localhost") : typeof args[1] === "string" ? args[1] : "localhost";
  return String(value)
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function urlFromOptions(options = {}) {
  const protocol = options.protocol ?? "http:";
  const hostname = options.hostname ?? options.host ?? "localhost";
  return `${protocol}//${hostname}${options.port ? `:${options.port}` : ""}${options.path ?? "/"}`;
}

function assertLoopbackUrl(input) {
  const url = new URL(String(input), "http://localhost");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!loopbackHosts.has(host)) throw offlineError(`network request to ${url.hostname}`);
}

function offlineError(action) {
  const error = new Error(`AETHEROPS_OFFLINE_VERIFY blocked ${action}.`);
  error.code = "AETHEROPS_OFFLINE_NETWORK_DENIED";
  return error;
}
