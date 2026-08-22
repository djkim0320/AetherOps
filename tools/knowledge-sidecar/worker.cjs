"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const oxigraphModule = process.env.AETHEROPS_OXIGRAPH_MODULE;
if (!oxigraphModule) throw new Error("AETHEROPS_OXIGRAPH_MODULE is required");
const oxigraph = require(oxigraphModule);
const { ProtocolError, validateReadonlyQuery } = require("./protocol.cjs");

if (!parentPort) throw new Error("knowledge worker requires a parent port");

function termJSON(term) {
  if (!term || typeof term !== "object") return term;
  const output = { term_type: term.termType, value: term.value };
  if (term.language) output.language = term.language;
  if (term.datatype?.value) output.datatype = term.datatype.value;
  if (term.subject) output.subject = termJSON(term.subject);
  if (term.predicate) output.predicate = termJSON(term.predicate);
  if (term.object) output.object = termJSON(term.object);
  if (term.graph) output.graph = termJSON(term.graph);
  return output;
}

function serializeQueryResult(value, queryType, maxRows, maxBytes) {
  let result;
  if (queryType === "ask") {
    if (typeof value !== "boolean") throw new ProtocolError("invalid_engine_result", "ASK did not return a boolean");
    result = { type: "ask", boolean: value };
  } else if (queryType === "select") {
    if (!Array.isArray(value)) throw new ProtocolError("invalid_engine_result", "SELECT did not return bindings");
    if (value.length > maxRows) throw new ProtocolError("row_limit_exceeded", `query returned more than ${maxRows} rows; no partial result was emitted`);
    const variables = new Set();
    const rows = value.map((binding) => {
      const row = {};
      for (const [key, term] of binding.entries()) {
        const name = String(key).replace(/^\?/, "");
        variables.add(name);
        row[name] = termJSON(term);
      }
      return row;
    });
    result = { type: "select", variables: [...variables], rows };
  } else {
    if (!Array.isArray(value)) throw new ProtocolError("invalid_engine_result", `${queryType.toUpperCase()} did not return quads`);
    if (value.length > maxRows) throw new ProtocolError("row_limit_exceeded", `query returned more than ${maxRows} quads; no partial result was emitted`);
    result = { type: queryType, quads: value.map(termJSON) };
  }
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes > maxBytes) {
    throw new ProtocolError("result_too_large", `serialized result is ${bytes} bytes, exceeding max_bytes=${maxBytes}; no partial result was emitted`);
  }
  return result;
}

function loadSnapshotStore(snapshot, tripleCount) {
  const candidate = new oxigraph.Store();
  candidate.load(snapshot, { format: "application/n-quads" });
  const actualTripleCount = candidate.match().length;
  if (actualTripleCount !== tripleCount) {
    throw new ProtocolError("triple_count_mismatch", `loaded ${actualTripleCount} unique quads, expected ${tripleCount}`);
  }
  return { candidate, actualTripleCount };
}

let store;
try {
  const loaded = loadSnapshotStore(workerData.snapshot, workerData.tripleCount);
  store = loaded.candidate;
  workerData.snapshot = undefined;
  parentPort.postMessage({ type: "ready", tripleCount: loaded.actualTripleCount });
} catch (error) {
  workerData.snapshot = undefined;
  parentPort.postMessage({
    type: "load_error",
    error: { code: error?.code || "snapshot_parse_failed", message: error instanceof Error ? error.message : String(error) }
  });
}

parentPort.on("message", (message) => {
  if (!store || message?.type !== "query") return;
  const started = Date.now();
  try {
    const queryType = validateReadonlyQuery(message.query);
    if (queryType !== message.queryType) throw new ProtocolError("query_validation_mismatch", "query type changed between validation passes");
    const value = store.query(message.query);
    const result = serializeQueryResult(value, queryType, message.maxRows, message.maxBytes);
    result.elapsed_ms = Date.now() - started;
    const finalBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (finalBytes > message.maxBytes) {
      throw new ProtocolError("result_too_large", `serialized result is ${finalBytes} bytes, exceeding max_bytes=${message.maxBytes}; no partial result was emitted`);
    }
    parentPort.postMessage({ type: "query_result", requestID: message.requestID, result });
  } catch (error) {
    parentPort.postMessage({
      type: "query_error",
      requestID: message.requestID,
      error: { code: error?.code || "query_failed", message: error instanceof Error ? error.message : String(error) }
    });
  }
});
