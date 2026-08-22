"use strict";

const PROTOCOL_ID = "aetherops-oxigraph-stdio-v1";
const OXIGRAPH_CONTRACT_VERSION = "0.5.9";

const LIMITS = Object.freeze({
  maxLineBytes: 24 * 1024 * 1024,
  maxSnapshotBytes: 16 * 1024 * 1024,
  maxTripleCount: 250_000,
  maxCacheEntries: 6,
  maxProjects: 4,
  maxGenerationsPerProject: 2,
  maxCacheSnapshotBytes: 48 * 1024 * 1024,
  maxQueryBytes: 64 * 1024,
  maxRows: 1_000,
  maxResultBytes: 8 * 1024 * 1024,
  maxTimeoutMs: 30_000
});

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function requireString(value, name, maxLength = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProtocolError("invalid_request", `${name} must be a non-empty printable string no longer than ${maxLength} characters`);
  }
  return value;
}

function requireRequestID(value) {
  if (typeof value === "string") return requireString(value, "id", 128);
  if (Number.isSafeInteger(value) && value >= 0) return value;
  throw new ProtocolError("invalid_request", "id must be a non-negative safe integer or a printable string");
}

function requireInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProtocolError("invalid_request", `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function rejectUnknownKeys(request, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(request).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ProtocolError("invalid_request", `unexpected request fields: ${unexpected.join(", ")}`);
  }
}

function isIRIReferenceStart(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === ">") return true;
    if (/\s/.test(character) || /[<"{}|^`\\]/.test(character) || character.charCodeAt(0) <= 0x20) {
      return false;
    }
  }
  return false;
}

function maskSparqlLiterals(source) {
  let output = "";
  let index = 0;
  let state = "code";
  let delimiter = "";
  while (index < source.length) {
    const character = source[index];
    const nextThree = source.slice(index, index + 3);
    if (state === "comment") {
      if (character === "\n" || character === "\r") {
        state = "code";
        output += character;
      } else output += " ";
      index += 1;
      continue;
    }
    if (state === "iri") {
      if (character === ">") {
        state = "code";
        output += ">";
      } else output += " ";
      index += 1;
      continue;
    }
    if (state === "string") {
      if (character === "\\") {
        output += "  ";
        index += Math.min(2, source.length - index);
        continue;
      }
      if (delimiter.length === 3 && nextThree === delimiter) {
        output += "   ";
        index += 3;
        state = "code";
        continue;
      }
      if (delimiter.length === 1 && character === delimiter) {
        output += " ";
        index += 1;
        state = "code";
        continue;
      }
      output += character === "\n" || character === "\r" ? character : " ";
      index += 1;
      continue;
    }
    if (character === "#") {
      state = "comment";
      output += " ";
      index += 1;
      continue;
    }
    if (character === "<" && isIRIReferenceStart(source, index)) {
      state = "iri";
      output += "<";
      index += 1;
      continue;
    }
    if (nextThree === '\"\"\"' || nextThree === "'''") {
      delimiter = nextThree;
      state = "string";
      output += "   ";
      index += 3;
      continue;
    }
    if (character === '\"' || character === "'") {
      delimiter = character;
      state = "string";
      output += " ";
      index += 1;
      continue;
    }
    output += character;
    index += 1;
  }
  if (state === "iri") throw new ProtocolError("invalid_query", "unterminated SPARQL IRI");
  if (state === "string") throw new ProtocolError("invalid_query", "unterminated SPARQL string literal");
  return output;
}

const updateKeywords = [
  "INSERT", "DELETE", "LOAD", "CLEAR", "CREATE", "DROP", "COPY", "MOVE", "ADD", "WITH", "USING", "FROM"
];

function validateReadonlyQuery(query) {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new ProtocolError("invalid_query", "query must be a non-empty SPARQL string");
  }
  if (Buffer.byteLength(query, "utf8") > LIMITS.maxQueryBytes) {
    throw new ProtocolError("query_too_large", `query exceeds ${LIMITS.maxQueryBytes} UTF-8 bytes`);
  }
  const masked = maskSparqlLiterals(query.replace(/^\uFEFF/, ""));
  const tokens = masked.split(/[\s{}();,.\[\]]+/).map((token) => token.trim()).filter(Boolean);
  let operation;
  for (const token of tokens) {
    if (token.startsWith("?") || token.startsWith("$") || token.includes(":")) continue;
    const upper = token.toUpperCase();
    if (upper === "SERVICE") throw new ProtocolError("service_forbidden", "SPARQL SERVICE clauses are forbidden");
    if (updateKeywords.includes(upper)) {
      throw new ProtocolError("update_forbidden", "SPARQL Update and external dataset operations are forbidden");
    }
    if (!operation && ["SELECT", "ASK", "CONSTRUCT", "DESCRIBE"].includes(upper)) operation = upper;
  }
  if (!operation) {
    throw new ProtocolError("query_type_forbidden", "only SELECT, ASK, CONSTRUCT, and DESCRIBE queries are allowed");
  }
  return operation.toLowerCase();
}

function validateEnvelope(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new ProtocolError("invalid_request", "each JSONL line must contain one request object");
  }
  const id = requireRequestID(request.id);
  const method = requireString(request.method, "method", 16);
  const projectID = requireString(request.project_id, "project_id");
  const generationID = requireString(request.generation_id, "generation_id");
  if (method !== "load" && method !== "query") {
    throw new ProtocolError("method_forbidden", "method must be 'load' or 'query'");
  }
  return { id, method, projectID, generationID };
}

function validateHelloRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new ProtocolError("invalid_request", "each JSONL line must contain one request object");
  }
  const id = requireRequestID(request.id);
  rejectUnknownKeys(request, ["id", "method", "protocol"]);
  if (request.method !== "hello" || request.protocol !== PROTOCOL_ID) {
    throw new ProtocolError("protocol_mismatch", `protocol must be ${PROTOCOL_ID}`);
  }
  return { id, protocol: PROTOCOL_ID, oxigraphVersion: OXIGRAPH_CONTRACT_VERSION };
}

function validateLoadRequest(request) {
  const envelope = validateEnvelope(request);
  if (envelope.method !== "load") throw new ProtocolError("invalid_request", "expected method 'load'");
  rejectUnknownKeys(request, [
    "id", "method", "project_id", "generation_id", "snapshot_nquads", "snapshot_sha256", "triple_count"
  ]);
  if (typeof request.snapshot_nquads !== "string") {
    throw new ProtocolError("invalid_snapshot", "snapshot_nquads must be an inline UTF-8 N-Quads string");
  }
  const snapshotBytes = Buffer.byteLength(request.snapshot_nquads, "utf8");
  if (snapshotBytes > LIMITS.maxSnapshotBytes) {
    throw new ProtocolError("snapshot_too_large", `snapshot exceeds ${LIMITS.maxSnapshotBytes} UTF-8 bytes`);
  }
  if (typeof request.snapshot_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(request.snapshot_sha256)) {
    throw new ProtocolError("invalid_snapshot_hash", "snapshot_sha256 must be a lowercase SHA-256 hex digest");
  }
  const tripleCount = requireInteger(request.triple_count, "triple_count", 0, LIMITS.maxTripleCount);
  return { ...envelope, snapshot: request.snapshot_nquads, snapshotBytes, snapshotSHA256: request.snapshot_sha256, tripleCount };
}

function validateQueryRequest(request) {
  const envelope = validateEnvelope(request);
  if (envelope.method !== "query") throw new ProtocolError("invalid_request", "expected method 'query'");
  rejectUnknownKeys(request, [
    "id", "method", "project_id", "generation_id", "query", "max_rows", "max_bytes", "timeout_ms"
  ]);
  const queryType = validateReadonlyQuery(request.query);
  const maxRows = requireInteger(request.max_rows, "max_rows", 1, LIMITS.maxRows);
  const maxBytes = requireInteger(request.max_bytes, "max_bytes", 256, LIMITS.maxResultBytes);
  const timeoutMs = requireInteger(request.timeout_ms, "timeout_ms", 1, LIMITS.maxTimeoutMs);
  return { ...envelope, query: request.query, queryType, maxRows, maxBytes, timeoutMs };
}

module.exports = {
	PROTOCOL_ID,
	OXIGRAPH_CONTRACT_VERSION,
  LIMITS,
  ProtocolError,
  validateEnvelope,
	validateHelloRequest,
  validateLoadRequest,
  validateQueryRequest,
  validateReadonlyQuery
};
