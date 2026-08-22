#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const {
	PROTOCOL_ID,
	OXIGRAPH_CONTRACT_VERSION,
  LIMITS,
  ProtocolError,
	validateEnvelope,
	validateHelloRequest,
  validateLoadRequest,
  validateQueryRequest
} = require("./protocol.cjs");

const cache = new Map();
let requestSequence = 0;
let inputBuffer = Buffer.alloc(0);
let discardingOversizeLine = false;
let operationChain = Promise.resolve();
let protocolNegotiated = false;

function cacheKey(projectID, generationID) {
  return `${projectID}\u0000${generationID}`;
}

function errorPayload(error) {
  const code = error?.code || "internal_error";
  const message = error instanceof Error ? error.message : String(error);
  return `[${code}] ${message}`;
}

function response(id, ok, result, error) {
  const validID = typeof id === "string" || (Number.isSafeInteger(id) && id >= 0) ? id : null;
  return { id: validID, ok, result: result ?? null, error: error ?? null };
}

function writeResponse(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function terminateEntry(entry) {
  if (!entry || entry.terminated) return;
  entry.terminated = true;
  await entry.worker.terminate().catch(() => undefined);
}

async function removeEntry(key) {
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  await terminateEntry(entry);
}

function lruEntries(predicate = () => true) {
  return [...cache.entries()].filter(([, entry]) => predicate(entry)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
}

async function enforceCacheBounds(insertedKey) {
  const inserted = cache.get(insertedKey);
  if (!inserted) return;
  const sameProject = lruEntries((entry) => entry.projectID === inserted.projectID && entry.key !== insertedKey);
  while (sameProject.length >= LIMITS.maxGenerationsPerProject) {
    const [key] = sameProject.shift();
    await removeEntry(key);
  }
  const projectIDs = new Set([...cache.values()].map((entry) => entry.projectID));
  while (projectIDs.size > LIMITS.maxProjects) {
    const candidate = lruEntries((entry) => entry.key !== insertedKey)[0];
    if (!candidate) break;
    const projectID = candidate[1].projectID;
    for (const [key, entry] of [...cache.entries()]) if (entry.projectID === projectID) await removeEntry(key);
    projectIDs.delete(projectID);
  }
  const totalBytes = () => [...cache.values()].reduce((sum, entry) => sum + entry.snapshotBytes, 0);
  while (cache.size > LIMITS.maxCacheEntries || totalBytes() > LIMITS.maxCacheSnapshotBytes) {
    const candidate = lruEntries((entry) => entry.key !== insertedKey)[0];
    if (!candidate) break;
    await removeEntry(candidate[0]);
  }
}

function createLoadedWorker(load) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "worker.cjs"), {
      workerData: { snapshot: load.snapshot, tripleCount: load.tripleCount },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new ProtocolError("load_timeout", "snapshot load exceeded 30000 ms"));
    }, LIMITS.maxTimeoutMs);
    worker.once("message", (message) => {
      if (settled) return;
      if (message?.type !== "ready") {
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        reject(new ProtocolError(message?.error?.code || "snapshot_parse_failed", message?.error?.message || "snapshot worker failed to load"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ worker, tripleCount: message.tripleCount });
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ProtocolError("worker_exited", `snapshot worker exited with code ${code}`));
    });
  });
}

async function handleLoad(request) {
  const load = validateLoadRequest(request);
  const actualHash = crypto.createHash("sha256").update(load.snapshot, "utf8").digest("hex");
  const expected = Buffer.from(load.snapshotSHA256, "hex");
  const actual = Buffer.from(actualHash, "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new ProtocolError("snapshot_hash_mismatch", `snapshot SHA-256 mismatch: expected ${load.snapshotSHA256}, got ${actualHash}`);
  }
  const key = cacheKey(load.projectID, load.generationID);
  const previous = cache.get(key);
  if (previous && !previous.terminated && previous.snapshotSHA256 === load.snapshotSHA256
      && previous.tripleCount === load.tripleCount && previous.snapshotBytes === load.snapshotBytes) {
    previous.lastUsed = Date.now();
    return {
      project_id: load.projectID,
      generation_id: load.generationID,
      snapshot_sha256: load.snapshotSHA256,
      triple_count: previous.tripleCount,
      replaced: false,
      reused: true,
      cache_entries: cache.size
    };
  }
  const loaded = await createLoadedWorker(load);
  const now = Date.now();
  const entry = {
    key,
    projectID: load.projectID,
    generationID: load.generationID,
    snapshotSHA256: load.snapshotSHA256,
    snapshotBytes: load.snapshotBytes,
    tripleCount: loaded.tripleCount,
    worker: loaded.worker,
    loadedAt: now,
    lastUsed: now,
    terminated: false
  };
  cache.set(key, entry);
  if (previous) await terminateEntry(previous);
  await enforceCacheBounds(key);
  return {
    project_id: load.projectID,
    generation_id: load.generationID,
    snapshot_sha256: load.snapshotSHA256,
    triple_count: loaded.tripleCount,
    replaced: Boolean(previous),
    reused: false,
    cache_entries: cache.size
  };
}

function runWorkerQuery(entry, query) {
  return new Promise((resolve, reject) => {
    const requestID = `${process.pid}:${++requestSequence}`;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      entry.worker.off("message", onMessage);
      entry.worker.off("error", onError);
      entry.worker.off("exit", onExit);
    };
    const fail = (error, invalidate) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (invalidate) void removeEntry(entry.key);
      reject(error);
    };
    const onMessage = (message) => {
      if (message?.requestID !== requestID || settled) return;
      if (message.type === "query_error") {
        fail(new ProtocolError(message.error?.code || "query_failed", message.error?.message || "query failed"), false);
        return;
      }
      if (message.type !== "query_result") return;
      settled = true;
      cleanup();
      resolve(message.result);
    };
    const onError = (error) => fail(error, true);
    const onExit = (code) => fail(new ProtocolError("worker_exited", `query worker exited with code ${code}`), true);
    const timer = setTimeout(() => {
      fail(new ProtocolError("query_timeout", `query exceeded timeout_ms=${query.timeoutMs}; worker cache was discarded and no partial result was emitted`), true);
    }, query.timeoutMs);
    entry.worker.on("message", onMessage);
    entry.worker.once("error", onError);
    entry.worker.once("exit", onExit);
    entry.worker.postMessage({
      type: "query",
      requestID,
      query: query.query,
      queryType: query.queryType,
      maxRows: query.maxRows,
      maxBytes: query.maxBytes
    });
  });
}

async function handleQuery(request) {
  const query = validateQueryRequest(request);
  const key = cacheKey(query.projectID, query.generationID);
  const entry = cache.get(key);
  if (!entry || entry.terminated) {
    throw new ProtocolError("snapshot_not_loaded", "the requested project generation is not loaded in this sidecar process");
  }
  entry.lastUsed = Date.now();
  return runWorkerQuery(entry, query);
}

async function handleRequest(request) {
	if (request?.method === "hello") {
		const hello = validateHelloRequest(request);
		protocolNegotiated = true;
		return { protocol: PROTOCOL_ID, oxigraph_version: OXIGRAPH_CONTRACT_VERSION };
	}
	if (!protocolNegotiated) {
		throw new ProtocolError("protocol_required", "hello protocol negotiation is required before load or query");
	}
  const envelope = validateEnvelope(request);
  return envelope.method === "load" ? handleLoad(request) : handleQuery(request);
}

async function processLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeResponse(response(null, false, null, "[invalid_json] input line is not valid JSON"));
    return;
  }
  try {
    const result = await handleRequest(request);
    writeResponse(response(request.id, true, result, null));
  } catch (error) {
    writeResponse(response(request?.id, false, null, errorPayload(error)));
  }
}

function enqueueLine(lineBuffer) {
  if (lineBuffer.length === 0) return;
  const line = lineBuffer.toString("utf8").replace(/\r$/, "");
  operationChain = operationChain.then(() => processLine(line), () => processLine(line));
}

process.stdin.on("data", (chunk) => {
  let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (discardingOversizeLine) {
    const newline = data.indexOf(0x0a);
    if (newline < 0) return;
    discardingOversizeLine = false;
    data = data.subarray(newline + 1);
  }
  inputBuffer = Buffer.concat([inputBuffer, data]);
  for (;;) {
    const newline = inputBuffer.indexOf(0x0a);
    if (newline < 0) break;
    const line = inputBuffer.subarray(0, newline);
    inputBuffer = inputBuffer.subarray(newline + 1);
    if (line.length > LIMITS.maxLineBytes) {
      writeResponse(response(null, false, null, `[line_too_large] JSONL line exceeds ${LIMITS.maxLineBytes} bytes`));
    } else enqueueLine(line);
  }
  if (inputBuffer.length > LIMITS.maxLineBytes) {
    inputBuffer = Buffer.alloc(0);
    discardingOversizeLine = true;
    writeResponse(response(null, false, null, `[line_too_large] JSONL line exceeds ${LIMITS.maxLineBytes} bytes`));
  }
});

process.stdin.on("end", () => {
  if (!discardingOversizeLine && inputBuffer.length > 0) enqueueLine(inputBuffer);
  inputBuffer = Buffer.alloc(0);
  operationChain.finally(async () => {
    await Promise.all([...cache.values()].map(terminateEntry));
  });
});

process.stdin.resume();

module.exports = { handleRequest, LIMITS };
