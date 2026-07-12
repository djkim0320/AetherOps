import type { AppSettings, EvidenceItem, ResearchToolInput, ResearchArtifact, ResearchLoopStep, ResearchSource, ToolRun } from "../shared/types.js";
import type { ResearchSourceAccessPolicy } from "../shared/adapterTypes.js";
import type { LlmInvocationMetadata } from "../providers/llm.js";
import type { CapabilityKind, CapabilityPolicy } from "../domain/capabilities/types.js";

export type ToolPhase = "acquisition.discovery" | "acquisition.fetch" | "binding" | "exclusive" | "analysis" | "artifact";

export interface ResearchToolResult {
  toolRun: ToolRun;
  evidence: EvidenceItem[];
  artifacts: ResearchArtifact[];
  sources: ResearchSource[];
}

export interface ResearchTool {
  name: string;
  run(input: ResearchToolInput, settings: AppSettings, context?: ResearchToolExecutionContext): Promise<ResearchToolResult>;
}

export interface ResearchToolExecutionContext {
  signal: AbortSignal;
  jobId?: string;
  attemptId: string;
  decisionId: string;
  ordinal: number;
  phase: ToolPhase;
  inputs: Record<string, unknown>;
  purpose?: string;
  expectedOutcome?: string;
  stagingRef?: string;
  dependsOnAttemptIds?: string[];
  onNetworkAudit?: (audit: NetworkAuditEvent) => void | Promise<void>;
  onCheckpoint?: (step: ResearchLoopStep) => void | Promise<void>;
  onCodexCliStage?: (stage: import("../shared/adapterTypes.js").CodexCliStage) => void | Promise<void>;
  resumeCheckpointStep?: ResearchLoopStep;
}

export interface NetworkAuditEvent {
  attemptId?: string;
  url: string;
  redirectChain: string[];
  sourcePolicy: ResearchSourceAccessPolicy;
  policyDecision: "allowed" | "denied";
  reason?: string;
  auditedAt: string;
}

export type ToolExecutionStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "interrupted" | "quarantined";

export interface ToolExecutionStatusEvent extends ResearchToolExecutionContext {
  toolName: string;
  status: ToolExecutionStatus;
  occurredAt: string;
  error?: string;
  policyStatus?: "accepted" | "rejected";
  policyReason?: string;
  outputIds?: string[];
  outputHash?: string;
  outputs?: Array<{
    id: string;
    kind: "source" | "evidence" | "artifact";
    name?: string;
    artifactKind?: string;
  }>;
  quarantineRef?: string;
  terminalCause?: string;
  codexCliTrace?: import("../shared/adapterTypes.js").CodexCliTaskResult["trace"];
}

export interface ToolExecutionJournal {
  beginExecution(input: { executionId: string; projectId: string; jobId?: string; iteration: number; actionCount: number; startedAt: string }): Promise<void>;
  record(event: ToolExecutionStatusEvent, result?: ResearchToolResult): Promise<void>;
  completeExecution(executionId: string, completedAt: string): Promise<void>;
  quarantineExecution(executionId: string, reason: string, completedAt: string): Promise<string | undefined>;
  prepareQuarantine?(executionId: string, reason: string, completedAt: string): Promise<string | undefined>;
  commitQuarantine?(executionId: string): Promise<string | undefined>;
  actionWorkspace?(executionId: string, actionId: string): string | undefined;
}

export interface ToolExecutionContext {
  jobId?: string;
  executionId?: string;
  idempotencyKey?: string;
  allowCodexCli?: boolean;
  effectiveCapabilities?: CapabilityPolicy;
  authorizeAction?: (action: { name: string; requiredCapabilities: CapabilityKind[] }) => Promise<CapabilityPolicy>;
  toolPolicy?: {
    allowCodexCli: boolean;
    sourceAccess: ResearchSourceAccessPolicy;
  };
  signal?: AbortSignal;
  onStatus?: (event: ToolExecutionStatusEvent) => void | Promise<void>;
  onLlmInvocation?: (metadata: LlmInvocationMetadata) => void | Promise<void>;
  onNetworkAudit?: (audit: NetworkAuditEvent) => void | Promise<void>;
  onCheckpoint?: (step: ResearchLoopStep) => void | Promise<void>;
  resumeCheckpointStep?: ResearchLoopStep;
}
