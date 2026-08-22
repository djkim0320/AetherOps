"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const { PROTOCOL_ID, OXIGRAPH_CONTRACT_VERSION } = require("../protocol.cjs");

const sidecarPath = path.join(__dirname, "..", "index.cjs");
const oxigraphModule = process.env.AETHEROPS_OXIGRAPH_MODULE
  || path.dirname(require.resolve("oxigraph/package.json"));

function runExchange(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [sidecarPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AETHEROPS_OXIGRAPH_MODULE: oxigraphModule }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`sidecar exited ${code}: ${stderr}`));
        return;
      }
      try {
        const responses = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        assert.equal(responses[0]?.ok, true);
        assert.deepEqual(responses[0]?.result, {
          protocol: PROTOCOL_ID,
          oxigraph_version: OXIGRAPH_CONTRACT_VERSION
        });
        resolve(responses.slice(1));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 0, method: "hello", protocol: PROTOCOL_ID })}\n`);
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}

function loadRequest(snapshot, overrides = {}) {
  return {
    id: 1,
    method: "load",
    project_id: "project-1",
    generation_id: "generation-1",
    snapshot_nquads: snapshot,
    snapshot_sha256: crypto.createHash("sha256").update(snapshot, "utf8").digest("hex"),
    triple_count: 2,
    ...overrides
  };
}

function queryRequest(query, overrides = {}) {
  return {
    id: 2,
    method: "query",
    project_id: "project-1",
    generation_id: "generation-1",
    query,
    max_rows: 10,
    max_bytes: 64 * 1024,
    timeout_ms: 5_000,
    ...overrides
  };
}

const snapshot = [
  '<https://example.test/a> <https://schema.test/name> "Alice" .',
  '<https://example.test/b> <https://schema.test/name> "Bob" .',
  ""
].join("\n");

test("loads a verified snapshot and queries the same project generation", async () => {
  const responses = await runExchange([
    loadRequest(snapshot),
    queryRequest("SELECT ?subject ?name WHERE { ?subject <https://schema.test/name> ?name } ORDER BY ?name")
  ]);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].result.triple_count, 2);
  assert.equal(responses[1].ok, true);
  assert.equal(responses[1].result.type, "select");
  assert.equal(responses[1].result.rows.length, 2);
});

test("reuses an identical immutable generation snapshot", async () => {
  const responses = await runExchange([
    loadRequest(snapshot),
    loadRequest(snapshot, { id: 2 }),
    queryRequest("ASK { <https://example.test/a> <https://schema.test/name> \"Alice\" }", { id: 3 })
  ]);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].result.reused, false);
  assert.equal(responses[1].ok, true);
  assert.equal(responses[1].result.reused, true);
  assert.equal(responses[1].result.replaced, false);
  assert.equal(responses[2].ok, true);
  assert.equal(responses[2].result.boolean, true);
});

test("accepts less-than comparison operators outside IRI references", async () => {
  const responses = await runExchange([
    loadRequest(snapshot),
    queryRequest("SELECT ?subject WHERE { ?subject <https://schema.test/name> ?name FILTER(strlen(str(?name)) < 4) }")
  ]);
  assert.equal(responses[1].ok, true);
  assert.equal(responses[1].result.type, "select");
  assert.equal(responses[1].result.rows.length, 1);
  assert.equal(responses[1].result.rows[0].subject.value, "https://example.test/b");
});

test("executes aggregate, subquery, property path, ASK, CONSTRUCT, and DESCRIBE query forms", async () => {
  const graphSnapshot = [
    '<https://example.test/a> <https://schema.test/name> "Alice" .',
    '<https://example.test/b> <https://schema.test/name> "Bob" .',
    '<https://example.test/a> <https://schema.test/parent> <https://example.test/b> .',
    '<https://example.test/b> <https://schema.test/parent> <https://example.test/c> .',
    ""
  ].join("\n");
  const responses = await runExchange([
    loadRequest(graphSnapshot, { triple_count: 4 }),
    queryRequest("SELECT (COUNT(?s) AS ?count) WHERE { ?s <https://schema.test/name> ?name }", { id: 2 }),
    queryRequest("SELECT ?s WHERE { { SELECT ?s WHERE { ?s <https://schema.test/name> ?name } } } ORDER BY ?s", { id: 3 }),
    queryRequest("SELECT ?target WHERE { <https://example.test/a> <https://schema.test/parent>+ ?target } ORDER BY ?target", { id: 4 }),
    queryRequest("ASK { <https://example.test/a> <https://schema.test/parent>+ <https://example.test/c> }", { id: 5 }),
    queryRequest("CONSTRUCT { ?s <https://schema.test/label> ?name } WHERE { ?s <https://schema.test/name> ?name }", { id: 6 }),
    queryRequest("DESCRIBE <https://example.test/a>", { id: 7 })
  ]);
  for (const response of responses) assert.equal(response.ok, true, response.error);
  assert.equal(responses[1].result.type, "select");
  assert.equal(responses[1].result.rows[0].count.value, "2");
  assert.equal(responses[2].result.rows.length, 2);
  assert.equal(responses[3].result.rows.length, 2);
  assert.equal(responses[4].result.type, "ask");
  assert.equal(responses[4].result.boolean, true);
  assert.equal(responses[5].result.type, "construct");
  assert.equal(responses[5].result.quads.length, 2);
  assert.equal(responses[6].result.type, "describe");
  assert.ok(responses[6].result.quads.length >= 2);
});

test("atomically loads an explicitly empty RDF dataset", async () => {
  const empty = "";
  const responses = await runExchange([
    loadRequest(empty, {
      triple_count: 0,
      snapshot_sha256: crypto.createHash("sha256").update(empty, "utf8").digest("hex")
    }),
    queryRequest("ASK { ?s ?p ?o }")
  ]);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].result.triple_count, 0);
  assert.equal(responses[1].ok, true);
  assert.equal(responses[1].result.boolean, false);
});

test("rejects update and federated SERVICE queries", async () => {
  const responses = await runExchange([
    loadRequest(snapshot),
    queryRequest('INSERT DATA { <https://example.test/c> <https://schema.test/name> "Carol" . }', { id: 2 }),
    queryRequest("SELECT * WHERE { SERVICE <https://remote.test/sparql> { ?s ?p ?o } }", { id: 3 })
  ]);
  assert.equal(responses[1].ok, false);
  assert.match(responses[1].error, /^\[update_forbidden\]/);
  assert.equal(responses[2].ok, false);
  assert.match(responses[2].error, /^\[service_forbidden\]/);
});

test("never returns a partial result when the row limit is exceeded", async () => {
  const responses = await runExchange([
    loadRequest(snapshot),
    queryRequest("SELECT ?s ?p ?o WHERE { ?s ?p ?o }", { max_rows: 1 })
  ]);
  assert.equal(responses[1].ok, false);
  assert.equal(responses[1].result, null);
  assert.match(responses[1].error, /^\[row_limit_exceeded\]/);
});

test("rejects a bad hash without replacing the verified generation", async () => {
  const responses = await runExchange([
    loadRequest(snapshot),
    loadRequest(snapshot, { id: 2, snapshot_sha256: "0".repeat(64) }),
    queryRequest("ASK { <https://example.test/a> <https://schema.test/name> \"Alice\" }")
  ]);
  assert.equal(responses[1].ok, false);
  assert.match(responses[1].error, /^\[snapshot_hash_mismatch\]/);
  assert.equal(responses[2].ok, true);
  assert.equal(responses[2].result.boolean, true);
});

test("requires an explicitly loaded snapshot generation", async () => {
  const responses = await runExchange([
    queryRequest("ASK { ?s ?p ?o }", { generation_id: "missing" })
  ]);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].error, /^\[snapshot_not_loaded\]/);
});

test("rejects filesystem or URL fields outside the stdin snapshot contract", async () => {
  const responses = await runExchange([
    loadRequest(snapshot, { snapshot_path: "C:\\untrusted\\graph.nq" })
  ]);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].error, /^\[invalid_request\]/);
  assert.match(responses[0].error, /snapshot_path/);
});
