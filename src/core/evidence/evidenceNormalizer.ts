import type { NormalizedResearchRecord, ResearchSnapshot, ResearchSource } from "../shared/types.js";
import { recordFromArtifact, recordFromPlan, recordFromResearchInput, recordFromSource, recordFromSpecification } from "./normalization/recordFactories.js";
import { appendRecordsFromEvidence } from "./normalization/evidenceRecordFactory.js";
import { appendRecordsFromToolRun } from "./normalization/toolRunRecordFactory.js";
import { dedupe } from "./normalization/normalizationHelpers.js";

export class EvidenceNormalizer {
  normalize(snapshot: ResearchSnapshot, iteration: number): NormalizedResearchRecord[] {
    const records: NormalizedResearchRecord[] = [];
    const sourceById = new Map<string, ResearchSource>();
    for (const source of snapshot.sources) sourceById.set(source.id, source);

    for (const input of snapshot.researchInputs) records.push(recordFromResearchInput(input, iteration));
    const specification = snapshot.specifications.at(-1);
    if (specification) records.push(recordFromSpecification(specification, iteration));
    const plan = snapshot.researchPlans.at(-1);
    if (plan) records.push(recordFromPlan(plan, iteration));

    for (const source of snapshot.sources) records.push(recordFromSource(source, iteration));
    for (const artifact of snapshot.artifacts) records.push(recordFromArtifact(artifact, iteration));
    for (const evidence of snapshot.evidence) {
      appendRecordsFromEvidence(records, evidence, iteration, sourceById.get(evidence.sourceId ?? ""));
    }
    for (const toolRun of snapshot.toolRuns) appendRecordsFromToolRun(records, toolRun);
    return dedupe(records);
  }
}
