import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type {
  StorageProjectMutationFinalizeInput,
  StorageProjectMutationFinalizeResult,
  StorageProjectMutationJournal,
  StorageProjectMutationMarkLegacyAppliedInput,
  StorageProjectMutationMarkResult,
  StorageProjectMutationMethod,
  StorageProjectMutationPendingPage,
  StorageProjectMutationPrepareInput,
  StorageProjectMutationPrepareResult
} from "../runtime/storage/v2/projectMutationTypes.js";
import type { StorageJobEvent } from "../runtime/storage/v2/types.js";

export class DurableProjectMutationStorage {
  constructor(
    private readonly client: StorageWorkerClient,
    private readonly publish: (event: StorageJobEvent) => void
  ) {}

  lookup(method: StorageProjectMutationMethod, requestId: string, requestHash: string): Promise<StorageProjectMutationJournal | undefined> {
    return this.client.request({ name: "projectMutation.lookup", method, requestId, requestHash });
  }

  prepare(input: StorageProjectMutationPrepareInput): Promise<StorageProjectMutationPrepareResult> {
    return this.client.request({ name: "projectMutation.prepare", input });
  }

  markLegacyApplied(input: StorageProjectMutationMarkLegacyAppliedInput): Promise<StorageProjectMutationMarkResult> {
    return this.client.request({ name: "projectMutation.markLegacyApplied", input });
  }

  async finalize(input: StorageProjectMutationFinalizeInput): Promise<StorageProjectMutationFinalizeResult> {
    const result = await this.client.request<StorageProjectMutationFinalizeResult>({ name: "projectMutation.finalize", input });
    this.publish(result.event);
    return result;
  }

  async listPending(): Promise<StorageProjectMutationJournal[]> {
    const mutations: StorageProjectMutationJournal[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.request<StorageProjectMutationPendingPage>({ name: "projectMutation.listPending", cursor, limit: 250 });
      mutations.push(...page.mutations);
      if (page.nextCursor !== undefined && page.nextCursor === cursor) throw new Error("Project mutation recovery cursor made no progress.");
      cursor = page.nextCursor;
    } while (cursor);
    return mutations;
  }
}
