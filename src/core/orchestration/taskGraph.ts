import { z } from "zod";
import {
  addDuplicateIssues,
  assertCanonicalHash,
  type CanonicalHasher,
  deepFreeze,
  type DeepReadonly,
  Sha256Schema,
  StableIdentifierSchema
} from "./orchestrationSchemas.js";

export const TaskGraphNodeSchema = z
  .object({
    id: StableIdentifierSchema,
    kind: StableIdentifierSchema,
    dependencyNodeIds: z.array(StableIdentifierSchema).max(64),
    terminal: z.boolean()
  })
  .strict();

export const TaskGraphSchema = z
  .object({
    schemaVersion: z.literal(1),
    graphId: StableIdentifierSchema,
    contentHash: Sha256Schema,
    nodes: z.array(TaskGraphNodeSchema).min(1).max(1_000)
  })
  .strict()
  .superRefine((graph, context) => validateTaskGraph(graph.nodes, context));

type ParsedTaskGraph = z.infer<typeof TaskGraphSchema>;
declare const verifiedTaskGraph: unique symbol;
export type TaskGraph = DeepReadonly<ParsedTaskGraph> & { readonly [verifiedTaskGraph]: true };

export function parseTaskGraph(input: unknown, hasher: CanonicalHasher): TaskGraph {
  const graph = TaskGraphSchema.parse(input);
  assertCanonicalHash("TaskGraph", graph.contentHash, taskGraphHashPayload(graph), hasher);
  return deepFreeze(graph) as TaskGraph;
}

export function taskGraphHashPayload(graph: ParsedTaskGraph): Omit<ParsedTaskGraph, "contentHash"> {
  const { contentHash, ...payload } = graph;
  void contentHash;
  return payload;
}

function validateTaskGraph(nodes: z.infer<typeof TaskGraphNodeSchema>[], context: z.RefinementCtx): void {
  const ids = nodes.map((node) => node.id);
  addDuplicateIssues(ids, context, "nodes");
  const known = new Set(ids);
  const dependentIds = new Set(nodes.flatMap((node) => node.dependencyNodeIds));
  if (!nodes.some((node) => node.terminal)) context.addIssue({ code: "custom", path: ["nodes"], message: "A task graph needs a terminal node." });
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    addDuplicateIssues(node.dependencyNodeIds, context, index);
    for (const dependencyId of node.dependencyNodeIds) {
      if (!known.has(dependencyId))
        context.addIssue({ code: "custom", path: ["nodes", index, "dependencyNodeIds"], message: `Unknown dependency: ${dependencyId}` });
      if (dependencyId === node.id)
        context.addIssue({ code: "custom", path: ["nodes", index, "dependencyNodeIds"], message: "A node cannot depend on itself." });
    }
    if (node.terminal && dependentIds.has(node.id))
      context.addIssue({ code: "custom", path: ["nodes", index, "terminal"], message: "A terminal node cannot have dependents." });
    if (!node.terminal && !nodes.some((candidate) => candidate.dependencyNodeIds.includes(node.id))) {
      context.addIssue({ code: "custom", path: ["nodes", index, "terminal"], message: "A leaf node must be marked terminal." });
    }
  }
  if (hasDependencyCycle(nodes)) context.addIssue({ code: "custom", path: ["nodes"], message: "Task graph dependencies must be acyclic." });
}

function hasDependencyCycle(nodes: z.infer<typeof TaskGraphNodeSchema>[]): boolean {
  const dependencies = new Map(nodes.map((node) => [node.id, node.dependencyNodeIds]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const dependency of dependencies.get(nodeId) ?? []) if (visit(dependency)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return nodes.some((node) => visit(node.id));
}
