import { ProjectSnapshotSchema, SnapshotGetParamsSchema } from "../../contracts/api-v2/snapshots.js";
import { callRpc } from "../platform/rpcTransport.js";

export const snapshotApi = {
  get: (projectId: string) => callRpc("snapshots.get", SnapshotGetParamsSchema.parse({ projectId }), ProjectSnapshotSchema)
};
