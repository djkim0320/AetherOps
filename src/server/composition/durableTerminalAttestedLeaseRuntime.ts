import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type {
  StorageTerminalAttestedLease,
  StorageTerminalAttestedLeaseChunk,
  StorageTerminalAttestedLeaseReadInput,
  StorageTerminalAttestedLeaseReleaseInput,
  StorageTerminalAttestedLeaseReleaseResult,
  StorageTerminalAttestedReadbackInput
} from "../runtime/storage/v2/terminalAttestedReadbackTypes.js";

export class DurableTerminalAttestedLeaseRuntime {
  constructor(private readonly client: StorageWorkerClient) {}

  create(input: StorageTerminalAttestedReadbackInput): Promise<StorageTerminalAttestedLease> {
    return this.client.request({ name: "terminal.createAttestedLease", input });
  }

  read(input: StorageTerminalAttestedLeaseReadInput): Promise<StorageTerminalAttestedLeaseChunk> {
    return this.client.request({ name: "terminal.readAttestedLease", input });
  }

  release(input: StorageTerminalAttestedLeaseReleaseInput): Promise<StorageTerminalAttestedLeaseReleaseResult> {
    return this.client.request({ name: "terminal.releaseAttestedLease", input });
  }
}
