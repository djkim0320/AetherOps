import { LeaseLostError } from "../runtime/storage/v2/leaseFence.js";
import type { StorageLeaseFence } from "../runtime/storage/v2/types.js";
import type { StorageFencedWriteCommand } from "../runtime/storage/worker/typedProtocol.js";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageTaskContract, StorageTaskContractInput } from "../runtime/storage/v2/runStateTypes.js";
import type { StorageRunOwnership } from "../runtime/storage/v2/runStateTypes.js";

export async function fencedCanonicalStorageWrite<T>(
  client: StorageWorkerClient,
  fence: StorageLeaseFence | undefined,
  jobId: string,
  command: Extract<StorageFencedWriteCommand, { name: "taskContract.save" | "runState.commit" | "contextPack.save" }>
): Promise<T> {
  if (!fence || fence.jobId !== jobId) throw new LeaseLostError(jobId);
  const [result] = await client.request<[T]>({ name: "fencedTransaction", fence, commands: [command] });
  return result;
}

export function fencedCanonicalTaskContractWrite(
  client: StorageWorkerClient,
  fence: StorageLeaseFence | undefined,
  activeProjectId: string | undefined,
  owner: StorageRunOwnership,
  contract: StorageTaskContractInput
): Promise<StorageTaskContract> {
  if (!fence || fence.jobId !== owner.jobId || activeProjectId !== owner.projectId || contract.projectId !== owner.projectId) {
    throw new LeaseLostError(owner.jobId);
  }
  return fencedCanonicalStorageWrite(client, fence, owner.jobId, {
    name: "taskContract.save",
    owner,
    contract
  });
}
