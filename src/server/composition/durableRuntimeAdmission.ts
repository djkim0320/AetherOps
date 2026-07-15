export type DurableRuntimeAdmissionState = "new" | "running" | "draining" | "aborting" | "closing_storage" | "closed";

export class DurableRuntimeAdmissionError extends Error {
  constructor(readonly state: DurableRuntimeAdmissionState) {
    super(`Durable job runtime is not accepting work (${state}).`);
    this.name = "DurableRuntimeAdmissionError";
  }
}
