import type { ProjectStorage } from "../storage/projectStorage.js";
import { buildResearchReport } from "./report.js";
import { createId, nowIso } from "../shared/ids.js";
import type { FinalResearchOutput, ResearchDatabase, ResearchSnapshot } from "../shared/types.js";

export class FinalOutputWriter {
  constructor(private readonly projectStorage: ProjectStorage) {}

  async write(snapshot: ResearchSnapshot, database: ResearchDatabase): Promise<FinalResearchOutput> {
    const report = buildResearchReport(snapshot);
    const graphExport = {
      projectId: snapshot.project.id,
      entities: snapshot.ontologyEntities,
      relations: snapshot.ontologyRelations,
      constraints: snapshot.ontologyConstraints,
      exportedAt: nowIso()
    };
    const artifactSummaries = [];
    for (const artifact of snapshot.artifacts) {
      artifactSummaries.push({
        id: artifact.id,
        title: artifact.title,
        relativePath: artifact.relativePath,
        rawPath: artifact.rawPath,
        mimeType: artifact.mimeType,
        summary: artifact.summary
      });
    }
    const artifactPackage = {
      projectId: snapshot.project.id,
      artifacts: artifactSummaries,
      toolRuns: snapshot.toolRuns,
      sources: snapshot.sources,
      exportedAt: nowIso()
    };
    const evidenceCitations = [];
    const evidenceCitationList: string[] = [];
    for (const evidence of snapshot.evidence) {
      evidenceCitations.push({
        id: evidence.id,
        title: evidence.title,
        citation: evidence.citation,
        sourceUri: evidence.sourceUri,
        sourceId: evidence.sourceId,
        reliabilityScore: evidence.reliabilityScore,
        limitations: evidence.limitations
      });
      evidenceCitationList.push(evidence.citation ?? evidence.sourceUri ?? evidence.sourceId ?? evidence.title);
    }
    const validationsByHypothesisId = new Map<string | undefined, typeof snapshot.validationResults>();
    for (const validation of snapshot.validationResults) {
      let validations = validationsByHypothesisId.get(validation.hypothesisId);
      if (!validations) {
        validations = [];
        validationsByHypothesisId.set(validation.hypothesisId, validations);
      }
      validations.push(validation);
    }
    const hypothesisVerification = [];
    for (const hypothesis of snapshot.hypotheses) {
      hypothesisVerification.push({
        id: hypothesis.id,
        statement: hypothesis.statement,
        status: hypothesis.status,
        confidence: hypothesis.confidence,
        validations: validationsByHypothesisId.get(hypothesis.id) ?? []
      });
    }
    const output: FinalResearchOutput = {
      id: createId("final"),
      projectId: snapshot.project.id,
      finalAnswer: report.answer,
      markdownReport: report.markdown ?? report.comprehensiveReport,
      hypothesisSummary: report.hypothesisVerification,
      evidenceCitationList,
      reusableKnowledgeAsset: report.reusableKnowledgeAsset,
      createdAt: nowIso()
    };
    const files = await this.projectStorage.writeFinalOutputFiles(
      snapshot.project,
      database,
      output,
      graphExport,
      artifactPackage,
      evidenceCitations,
      hypothesisVerification
    );

    return {
      ...output,
      reportPath: files.reportPath,
      ontologyExportPath: files.ontologyExportPath,
      artifactPackagePath: files.artifactPackagePath
    };
  }
}
