import type { CodexModelId, CodexReasoningEffort } from "../../../shared/kernel/codexModels.js";
export type {
  CodexCliAdapter,
  CodexCliAdapterRequest,
  CodexCliInputArtifact,
  CodexCliStage,
  CodexCliTaskInput,
  CodexCliTaskResult
} from "../../../core/shared/adapterTypes.js";
import type { CodexCliStage } from "../../../core/shared/adapterTypes.js";

export interface CodexCliResolution {
  command: string;
  argsPrefix: string[];
  packageRoot: string;
  version: string;
}

export interface CodexCliRunRequest {
  cwd: string;
  prompt: string;
  model: CodexModelId;
  reasoningEffort: CodexReasoningEffort;
  timeoutMs: number;
  outputSchemaPath: string;
  outputLastMessagePath: string;
  workspaceProfile:
    | { mode: "read-only" }
    | {
        mode: "workspace";
        inputsDirectoryName: "inputs";
        outputsDirectoryName: "outputs";
      };
  codexHome?: string;
  signal?: AbortSignal;
  onStage?: (stage: CodexCliStage) => void | Promise<void>;
}

export interface CodexCliProcessResult {
  cliVersion: string;
  exitCode: number;
  durationMs: number;
  eventCount: number;
  lastMessage: string;
  terminationReason?: "completed" | "aborted" | "timeout" | "process_error" | "entitlement_unavailable";
}
