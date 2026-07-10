import { createStableId, nowIso } from "../../shared/ids.js";
import { tagMemoryScope } from "../../memory/researchMemory.js";
import type { NormalizedRecordKind, NormalizedResearchRecord, ToolRun } from "../../shared/types.js";
import { joinPresent, metadata } from "./normalizationHelpers.js";

export function appendRecordsFromToolRun(records: NormalizedResearchRecord[], toolRun: ToolRun): void {
  const content = joinPresent("\n", toolRun.toolName, toolRun.status, JSON.stringify(toolRun.input), JSON.stringify(toolRun.output), toolRun.error);
  const isError = toolRun.status === "failed";
  records.push(
    tagMemoryScope(
      {
        id: createStableId("record", `${toolRun.id}:${isError ? "error" : "observation"}`),
        projectId: toolRun.projectId,
        iteration: toolRun.iteration,
        kind: isError ? "error" : "observation",
        title: `${toolRun.toolName} ${toolRun.status}`,
        content,
        sourceUri: `logs/iteration-${toolRun.iteration}.json`,
        metadata: metadata(isError ? "error" : "tool_observation", false, content, {
          toolRunId: toolRun.id,
          status: toolRun.status,
          error: toolRun.error,
          sourceKind: "log"
        }),
        confidence: toolRun.status === "completed" ? 0.65 : 0.2,
        validationStatus: isError ? "rejected" : "raw",
        createdAt: toolRun.completedAt || nowIso()
      },
      isError ? "ephemeral" : "project_only"
    )
  );

  if (toolRun.toolName === "OpenCodeStructuredOutput" && toolRun.status === "completed") {
    appendRecordsFromOpenCodeStructuredOutput(records, toolRun);
  }
}

export function appendRecordsFromOpenCodeStructuredOutput(records: NormalizedResearchRecord[], toolRun: ToolRun): void {
  const output = toolRun.output as { claims?: unknown; observations?: unknown } | undefined;
  appendStructuredItems(records, output?.claims, "claim", toolRun);
  appendStructuredItems(records, output?.observations, "observation", toolRun);
}

export function appendStructuredItems(
  records: NormalizedResearchRecord[],
  value: unknown,
  kind: Extract<NormalizedRecordKind, "claim" | "observation">,
  toolRun: ToolRun
): void {
  if (!Array.isArray(value)) return;
  const limit = Math.min(value.length, 48);
  for (let index = 0; index < limit; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object") continue;
    const record = item as { title?: unknown; content?: unknown; sourceUri?: unknown; citation?: unknown; metadata?: unknown };
    const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : `OpenCode ${kind} ${index + 1}`;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content && typeof record.sourceUri !== "string" && typeof record.citation !== "string") continue;
    const metadataExtra =
      record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata) ? (record.metadata as Record<string, unknown>) : {};
    records.push(
      tagMemoryScope(
        {
          id: createStableId("record", `${toolRun.id}:${kind}:${index}:${title}:${content.slice(0, 120)}`),
          projectId: toolRun.projectId,
          iteration: toolRun.iteration,
          kind,
          title,
          content,
          sourceUri: typeof record.sourceUri === "string" ? record.sourceUri : `logs/iteration-${toolRun.iteration}.json`,
          citation: typeof record.citation === "string" ? record.citation : undefined,
          metadata: metadata("tool_observation", false, content || title, {
            ...metadataExtra,
            toolRunId: toolRun.id,
            sourceKind: "log",
            openCodeStructuredOutput: true
          }),
          confidence: 0.4,
          validationStatus: "raw",
          createdAt: toolRun.completedAt || nowIso()
        },
        "project_only"
      )
    );
  }
}
