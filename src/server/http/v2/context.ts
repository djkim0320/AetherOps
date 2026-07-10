import type { AetherOpsOrchestrator } from "../../../core/orchestration/orchestrator.js";
import type { AppSettingsStore } from "../../runtime/storage/settingsStore.js";
import type { DurableJobRuntime } from "../../composition/durableJobRuntime.js";

export interface RpcHandlerContext {
  appRoot: string;
  dataRoot: string;
  host: string;
  port: number;
  startedAt: string;
  version: string;
  env: NodeJS.ProcessEnv;
  llm:
    | {
        name: string;
        isAvailable(): Promise<boolean>;
        getStatus(): Promise<{
          authenticated: boolean;
          cliAvailable: boolean;
          catalog: "supported" | "unsupported";
          access: "not_checked" | "available" | "unavailable";
          message?: string;
        }>;
      }
    | undefined;
  orchestrator: AetherOpsOrchestrator;
  settingsStore: AppSettingsStore;
  events: DurableJobRuntime;
  jobs: DurableJobRuntime;
}
