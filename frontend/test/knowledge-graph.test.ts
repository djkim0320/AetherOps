import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptKnowledgeSubgraph,
  filterKnowledgeGraph,
  graphFilterOptions,
  knowledgeGraphElements
} from "../src/knowledge-graph.ts";
import { KNOWLEDGE_MAX_EDGES, KNOWLEDGE_MAX_NODES } from "../src/knowledge-types.ts";

test("adapter enforces render caps without leaking hidden conflict state", () => {
  const nodes = Array.from({ length: KNOWLEDGE_MAX_NODES + 5 }, (_, index) => ({
    id: `node-${index}`,
    label: `Node ${index}`
  }));
  const edges = Array.from({ length: KNOWLEDGE_MAX_EDGES + 1 }, (_, index) => ({
    id: `edge-${index}`,
    source: "node-0",
    target: "node-1",
    predicate: "connected_to",
    conflict: index === KNOWLEDGE_MAX_EDGES
  }));
  const payload = { graph: { nodes, edges } };

  const graph = adaptKnowledgeSubgraph(payload, "instance");
  assert.equal(graph.nodes.length, KNOWLEDGE_MAX_NODES);
  assert.equal(graph.edges.length, KNOWLEDGE_MAX_EDGES);
  assert.equal(graph.totalNodes, KNOWLEDGE_MAX_NODES + 5);
  assert.equal(graph.totalEdges, KNOWLEDGE_MAX_EDGES + 1);
  assert.equal(graph.truncated, true);
  assert.equal(graph.nodes[0]?.conflict, false, "a conflict edge beyond the render cap must not decorate visible nodes");

  const visibleIDs = new Set(graph.nodes.map((node) => node.id));
  assert.equal(new Set(graph.edges.map((edge) => edge.id)).size, graph.edges.length);
  assert.ok(graph.edges.every((edge) => visibleIDs.has(edge.source) && visibleIDs.has(edge.target)));
  assert.deepEqual(adaptKnowledgeSubgraph(payload, "instance"), graph, "the same payload must adapt deterministically");
});

test("adapter rejects malformed, dangling, duplicate, and invalid-time edges", () => {
  const graph = adaptKnowledgeSubgraph({
    subgraph: {
      nodes: [
        null,
        "not-a-node",
        { id: " a ", label: "First A" },
        { id: "a", label: "Duplicate A" },
        { entity_id: "b", name: "B" },
        { "@id": "c", title: "C" }
      ],
      edges: [
        { id: "shared", source: "a", target: "b", predicate: "uses" },
        { id: "shared", source: "a", target: "c", predicate: "conflicting_duplicate", conflict: true },
        { source: { id: "b" }, target: { entity_id: "c" }, relation: "urn:rel" },
        { id: "missing-target", source: "a" },
        { id: "dangling", source: "a", target: "absent" },
        { id: "invalid-time", source: "c", target: "a", valid_from: "not-a-date" },
        { id: "reverse-time", source: "c", target: "a", valid_from: "2027-01-01T00:00:00Z", valid_to: "2026-01-01T00:00:00Z" }
      ]
    }
  }, "instance");

  assert.deepEqual(graph.nodes.map((node) => [node.id, node.label]), [
    ["a", "First A"],
    ["b", "B"],
    ["c", "C"]
  ]);
  assert.deepEqual(graph.edges.map((edge) => [edge.id, edge.source, edge.target, edge.predicate]), [
    ["shared", "a", "b", "uses"],
    ["b::urn:rel::c::1", "b", "c", "urn:rel"]
  ]);
  assert.equal(graph.totalNodes, 3);
  assert.equal(graph.totalEdges, 2);
  assert.equal(graph.truncated, false);
  assert.ok(graph.nodes.every((node) => !node.conflict), "a discarded duplicate edge must not leak conflict state");
});

test("filtering and Cytoscape selection mapping are deterministic", () => {
  const graph = adaptKnowledgeSubgraph({
    nodes: [
      { id: "z", label: "Wing", kind: "component", types: ["Thing", "Zulu"] },
      { id: "a", label: "Aircraft", kind: "system", types: ["Vehicle"] },
      { id: "b", label: "Fleet", kind: "component", types: ["Thing"] }
    ],
    edges: [
      { id: "e1", source: "z", target: "a", predicate: "rel", valid_from: "2026-01-01T00:00:00Z", valid_to: "2026-12-31T00:00:00Z" },
      { id: "e2", source: "a", target: "b", predicate: "other", status: "disputed" }
    ]
  }, "instance");

  assert.deepEqual(graphFilterOptions(graph), {
    types: ["Thing", "Vehicle", "Zulu", "component", "system"],
    predicates: ["other", "rel"]
  });

  const temporalFilters = { query: "", type: "all", predicate: "rel", validAt: "2026-12-31T00:00:00Z", conflict: "all" as const };
  const temporal = filterKnowledgeGraph(graph, temporalFilters);
  assert.deepEqual(temporal.nodes.map((node) => node.id), ["z", "a"]);
  assert.deepEqual(temporal.edges.map((edge) => edge.id), ["e1"]);
  assert.deepEqual(filterKnowledgeGraph(graph, temporalFilters), temporal);

  const queried = filterKnowledgeGraph(graph, { query: "THING", type: "all", predicate: "all", validAt: "", conflict: "all" });
  assert.deepEqual(queried.nodes.map((node) => node.id), ["z", "b"]);
  assert.deepEqual(queried.edges, []);

  const conflicted = filterKnowledgeGraph(graph, { query: "", type: "all", predicate: "all", validAt: "", conflict: "only" });
  assert.deepEqual(conflicted.nodes.map((node) => node.id), ["a", "b"]);
  assert.deepEqual(conflicted.edges.map((edge) => edge.id), ["e2"]);

  const elements = knowledgeGraphElements(graph, new Set(["b", "missing"]));
  const nodeElements = elements.filter((element) => element.group === "nodes");
  const edgeElements = elements.filter((element) => element.group === "edges");
  assert.deepEqual(nodeElements.map((element) => [element.data.id, element.selected]), [
    ["z", false],
    ["a", false],
    ["b", true]
  ]);
  assert.deepEqual(edgeElements.map((element) => [element.data.id, element.data.source, element.data.target]), [
    ["e1", "z", "a"],
    ["e2", "a", "b"]
  ]);
});
