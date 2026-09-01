import assert from "node:assert/strict";
import test from "node:test";

import {
  compactSparqlTerm,
  describeSparqlTerm,
  normalizeSparqlTableResult
} from "../src/knowledge-sparql.ts";

test("AetherOps SPARQL envelope is normalized into a complete table", () => {
  const table = normalizeSparqlTableResult({
    query_form: "SELECT",
    complete: true,
    result: {
      type: "select",
      variables: ["subject", "value"],
      rows: [
        {
          subject: { term_type: "NamedNode", value: "urn:aetherops:core:hasValue" },
          value: {
            term_type: "Literal",
            value: "0.4828170395",
            datatype: "http://www.w3.org/2001/XMLSchema#decimal"
          }
        }
      ]
    }
  });
  assert.equal(table?.queryForm, "SELECT");
  assert.equal(table?.complete, true);
  assert.deepEqual(table?.variables, ["subject", "value"]);
  assert.equal(table?.rows[0]?.value?.value, "0.4828170395");
});

test("W3C SPARQL JSON bindings remain supported", () => {
  const table = normalizeSparqlTableResult({
    head: { vars: ["subject"] },
    results: { bindings: [{ subject: { type: "uri", value: "urn:test:item" } }] }
  });
  assert.equal(table?.rows.length, 1);
  assert.equal(table?.rows[0]?.subject?.termType, "uri");
  assert.equal(normalizeSparqlTableResult({ result: { type: "ask", value: true } }), null);
});

test("SPARQL terms are compact in cells while retaining exact provenance", () => {
  const named = { termType: "NamedNode", value: "urn:aetherops:core:hasValue" };
  const literal = {
    termType: "Literal",
    value: "68",
    datatype: "http://www.w3.org/2001/XMLSchema#integer"
  };
  assert.equal(compactSparqlTerm(named), "ao:hasValue");
  assert.equal(compactSparqlTerm(literal), "68");
  assert.equal(
    describeSparqlTerm(literal),
    "68^^http://www.w3.org/2001/XMLSchema#integer"
  );
});
