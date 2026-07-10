import type { ResearchInputPayload } from "../input/researchInput.js";
import type {
  Hypothesis,
  ResearchInput,
  ResearchPlan,
  ResearchQuestion,
  ResearchSnapshot,
  ResearchSource,
  ResearchSpecification,
  ResearchStore,
  ToolRun
} from "../shared/types.js";

export interface ActiveResearchContext {
  input?: ResearchInput;
  questions: ResearchQuestion[];
  hypotheses: Hypothesis[];
}

export function activeResearchSnapshot(snapshot: ResearchSnapshot): ResearchSnapshot {
  const context = activeResearchContext(snapshot);
  if (!context.input) return snapshot;
  const baseline = context.input.createdAt;
  const specifications = snapshot.specifications.filter((specification) => specification.sourceResearchInputId === context.input?.id);
  const activeSpecification = latestByCreatedAt(specifications);
  const researchPlans = snapshot.researchPlans.filter(
    (plan) =>
      plan.sourceResearchInputId === context.input?.id &&
      (!activeSpecification?.id || !plan.sourceSpecificationId || plan.sourceSpecificationId === activeSpecification.id)
  );
  return {
    ...snapshot,
    researchInputs: [context.input],
    questions: context.questions,
    hypotheses: context.hypotheses,
    evidence: itemsAtOrAfter(snapshot.evidence, baseline),
    artifacts: itemsAtOrAfter(snapshot.artifacts, baseline),
    sources: sourcesAtOrAfter(snapshot.sources, baseline),
    chunks: itemsAtOrAfter(snapshot.chunks, baseline),
    toolRuns: toolRunsAtOrAfter(snapshot.toolRuns, baseline),
    agentPlans: researchPlans,
    researchPlans,
    specifications,
    normalizedRecords: itemsAtOrAfter(snapshot.normalizedRecords, baseline),
    ontologyEntities: itemsAtOrAfter(snapshot.ontologyEntities, baseline),
    ontologyRelations: itemsAtOrAfter(snapshot.ontologyRelations, baseline),
    ontologyConstraints: itemsAtOrAfter(snapshot.ontologyConstraints, baseline),
    projectContextSnapshots: itemsAtOrAfter(snapshot.projectContextSnapshots, baseline),
    hybridContexts: itemsAtOrAfter(snapshot.hybridContexts, baseline),
    validationResults: itemsAtOrAfter(snapshot.validationResults, baseline),
    continuationDecisions: itemsAtOrAfter(snapshot.continuationDecisions, baseline),
    finalOutputs: itemsAtOrAfter(snapshot.finalOutputs, baseline),
    runAuditOutputs: itemsAtOrAfter(snapshot.runAuditOutputs, baseline),
    benchmarkPlans: itemsAtOrAfter(snapshot.benchmarkPlans, baseline),
    runtimeBlockers: itemsAtOrAfter(snapshot.runtimeBlockers, baseline),
    stepErrors: itemsAtOrAfter(snapshot.stepErrors, baseline),
    openCodeRuns: openCodeRunsAtOrAfter(snapshot.openCodeRuns, baseline),
    ragContexts: itemsAtOrAfter(snapshot.ragContexts, baseline),
    results: itemsAtOrAfter(snapshot.results, baseline),
    iterations: itemsAtOrAfter(snapshot.iterations, baseline),
    report: snapshot.report && isTimestampAtOrAfter(snapshot.report.createdAt, baseline) ? snapshot.report : undefined
  };
}

export function activeResearchContext(snapshot: ResearchSnapshot): ActiveResearchContext {
  const input = latestByCreatedAt(snapshot.researchInputs);
  if (!input) {
    return { questions: snapshot.questions, hypotheses: snapshot.hypotheses };
  }
  const questions = snapshot.questions.filter((question) => question.researchInputId === input.id);
  const questionIds = new Set(questions.map((question) => question.id));
  const hypotheses = snapshot.hypotheses.filter((hypothesis) => hypothesis.researchInputId === input.id && questionIds.has(hypothesis.questionId));
  return { input, questions, hypotheses };
}

export function activeResearchSpecification(snapshot: ResearchSnapshot): ResearchSpecification | undefined {
  const input = latestByCreatedAt(snapshot.researchInputs);
  if (input) {
    return latestByCreatedAt(snapshot.specifications.filter((specification) => specification.sourceResearchInputId === input.id));
  }
  return latestByCreatedAt(snapshot.specifications);
}

export function researchInputMatchesPayload(input: ResearchInput, payload: Required<ResearchInputPayload>): boolean {
  return (
    input.researchQuestion === payload.researchQuestion &&
    sameStringArray(input.initialHypotheses, payload.initialHypotheses) &&
    sameStringArray(input.constraints, payload.constraints) &&
    sameStringArray(input.expectedOutputs, payload.expectedOutputs)
  );
}

export function isPlanCurrentForActiveResearch(plan: ResearchPlan, snapshot: ResearchSnapshot, specification: ResearchSpecification | undefined): boolean {
  const input = latestByCreatedAt(snapshot.researchInputs);
  if (!input) return true;
  return plan.sourceResearchInputId === input.id && (!specification?.id || plan.sourceSpecificationId === specification.id);
}

export function activeMemorySearchStore(
  store: Pick<ResearchStore, "searchGlobalRecords" | "searchGlobalChunks" | "searchGlobalGraph">,
  snapshot: ResearchSnapshot
): Pick<ResearchStore, "searchGlobalRecords" | "searchGlobalChunks" | "searchGlobalGraph"> {
  const baseline = latestByCreatedAt(snapshot.researchInputs)?.createdAt;
  return {
    searchGlobalRecords: async (query, options) =>
      filterSameProjectItemsAtOrAfter(await store.searchGlobalRecords(query, options), snapshot.project.id, baseline),
    searchGlobalChunks: async (query, options) =>
      filterSameProjectItemsAtOrAfter(await store.searchGlobalChunks(query, options), snapshot.project.id, baseline),
    searchGlobalGraph: async (query, options) => {
      const graph = await store.searchGlobalGraph(query, options);
      return {
        entities: filterSameProjectItemsAtOrAfter(graph.entities, snapshot.project.id, baseline),
        relations: filterSameProjectItemsAtOrAfter(graph.relations, snapshot.project.id, baseline),
        constraints: filterSameProjectItemsAtOrAfter(graph.constraints, snapshot.project.id, baseline)
      };
    }
  };
}

export function latestByCreatedAt<T extends { createdAt: string }>(items: T[]): T | undefined {
  let latest: T | undefined;
  for (const item of items) {
    if (!latest || item.createdAt >= latest.createdAt) latest = item;
  }
  return latest;
}

export function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function findLastByIteration<T extends { iteration: number }>(items: T[], iteration: number): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.iteration === iteration) return item;
  }
  return undefined;
}

export function idsOf<T extends { id: string }>(items: T[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    ids.push(item.id);
  }
  return ids;
}

export function idSet<T extends { id: string }>(items: T[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) ids.add(item.id);
  return ids;
}

export function counts(snapshot: ResearchSnapshot): { evidence: number; artifacts: number; chunks: number; entities: number; relations: number } {
  return {
    evidence: snapshot.evidence.length,
    artifacts: snapshot.artifacts.length,
    chunks: snapshot.chunks.length,
    entities: snapshot.ontologyEntities.length,
    relations: snapshot.ontologyRelations.length
  };
}

function filterSameProjectItemsAtOrAfter<T extends { projectId: string; createdAt?: string; retrievedAt?: string }>(
  items: T[],
  projectId: string,
  baseline: string | undefined
): T[] {
  if (!baseline) return items;
  return items.filter((item) => item.projectId !== projectId || isTimestampAtOrAfter(timestampOf(item), baseline));
}

function itemsAtOrAfter<T extends { createdAt: string }>(items: T[], baseline: string): T[] {
  return items.filter((item) => isTimestampAtOrAfter(item.createdAt, baseline));
}

function sourcesAtOrAfter(sources: ResearchSource[], baseline: string): ResearchSource[] {
  return sources.filter((source) => isTimestampAtOrAfter(source.createdAt ?? source.retrievedAt, baseline));
}

function toolRunsAtOrAfter(toolRuns: ToolRun[], baseline: string): ToolRun[] {
  return toolRuns.filter((toolRun) => isTimestampAtOrAfter(toolRun.completedAt || toolRun.startedAt, baseline));
}

function openCodeRunsAtOrAfter(openCodeRuns: ResearchSnapshot["openCodeRuns"], baseline: string): ResearchSnapshot["openCodeRuns"] {
  return openCodeRuns.filter((run) => isTimestampAtOrAfter(run.completedAt ?? run.startedAt, baseline));
}

function timestampOf(item: { createdAt?: string; retrievedAt?: string }): string | undefined {
  return item.createdAt ?? item.retrievedAt;
}

function isTimestampAtOrAfter(value: string | undefined, baseline: string): boolean {
  return Boolean(value && value >= baseline);
}
