export type EngineeringAssessmentView = {
  outcome?: string;
  outcome_reason?: string;
};

type ReportContent = {
  answer_markdown?: string;
  engineering_assessment?: EngineeringAssessmentView | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function artifactRawText(content: unknown): string {
  if (typeof content === "string") return content;
  return content ? JSON.stringify(content, null, 2) : "";
}

export function artifactFormattedText(kind: string, content: unknown): string {
  if (kind !== "research.report" || !isRecord(content)) return artifactRawText(content);
  const report = content as ReportContent;
  if (typeof report.answer_markdown !== "string" || !report.answer_markdown.trim()) {
    return artifactRawText(content);
  }
  const assessment = isRecord(report.engineering_assessment)
    ? (report.engineering_assessment as EngineeringAssessmentView)
    : null;
  if (!assessment || typeof assessment.outcome !== "string") return report.answer_markdown;
  const label =
    assessment.outcome === "confirmed"
      ? "공학 결론 확인됨"
      : assessment.outcome === "inconclusive"
        ? "공학 결론 미확정"
        : `공학 결론 ${assessment.outcome}`;
  const reason =
    typeof assessment.outcome_reason === "string" ? assessment.outcome_reason.trim() : "";
  return `> ${label}${reason ? ` — ${reason}` : ""}\n\n${report.answer_markdown}`;
}
