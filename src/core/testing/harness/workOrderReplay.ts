import { HarnessError } from "./errors.js";
import type { TraceEvent } from "./traceSchemas.js";

export interface ReplayedWorkOrder {
  workOrderId: string;
  readOnly: boolean;
  scopeKeys: string[];
  dependencyWorkOrderIds: string[];
  outcome?: string;
  reasonCode?: string;
  conflictingWorkOrderId?: string;
}

export interface WorkOrderReplayContext {
  workOrders: Map<string, ReplayedWorkOrder>;
  completedWorkOrders: Set<string>;
}

export function applyWorkOrderCreated(
  context: WorkOrderReplayContext,
  stateWorkOrders: ReplayedWorkOrder[],
  data: Extract<TraceEvent, { type: "work_order.created" }>["data"]
): void {
  if (context.workOrders.has(data.workOrderId)) invalid(`Work order ID is duplicated: ${data.workOrderId}`);
  for (const dependency of data.dependencyWorkOrderIds) {
    if (dependency === data.workOrderId || !context.workOrders.has(dependency)) invalid(`Work order dependency was not created first: ${dependency}`);
  }
  const workOrder: ReplayedWorkOrder = {
    workOrderId: data.workOrderId,
    readOnly: data.readOnly,
    scopeKeys: [...data.scopeKeys],
    dependencyWorkOrderIds: [...data.dependencyWorkOrderIds]
  };
  context.workOrders.set(data.workOrderId, workOrder);
  stateWorkOrders.push(workOrder);
}

export function applyWorkOrderCompleted(context: WorkOrderReplayContext, data: Extract<TraceEvent, { type: "work_order.completed" }>["data"]): void {
  const workOrder = context.workOrders.get(data.workOrderId);
  if (!workOrder || context.completedWorkOrders.has(data.workOrderId)) invalid(`Work order completion is invalid: ${data.workOrderId}`);
  for (const dependency of workOrder.dependencyWorkOrderIds) {
    if (!context.completedWorkOrders.has(dependency)) invalid(`Work order dependency is incomplete: ${dependency}`);
  }
  if (data.reasonCode === "WRITE_SCOPE_CONFLICT") validateWriteScopeConflict(context, workOrder, data.conflictingWorkOrderId);
  context.completedWorkOrders.add(data.workOrderId);
  workOrder.outcome = data.outcome;
  if (data.reasonCode) workOrder.reasonCode = data.reasonCode;
  if (data.conflictingWorkOrderId) workOrder.conflictingWorkOrderId = data.conflictingWorkOrderId;
}

function validateWriteScopeConflict(context: WorkOrderReplayContext, blocked: ReplayedWorkOrder, conflictingWorkOrderId?: string): void {
  if (!conflictingWorkOrderId || conflictingWorkOrderId === blocked.workOrderId) invalid(`Write-scope conflict has no distinct owner: ${blocked.workOrderId}`);
  const owner = context.workOrders.get(conflictingWorkOrderId);
  if (!owner || owner.readOnly || blocked.readOnly) invalid(`Write-scope conflict does not reference two write work orders: ${blocked.workOrderId}`);
  if (owner.outcome !== "completed" || !context.completedWorkOrders.has(owner.workOrderId))
    invalid(`Write-scope conflict owner did not complete first: ${owner.workOrderId}`);
  const ownerScope = new Set(owner.scopeKeys);
  if (!blocked.scopeKeys.some((scopeKey) => ownerScope.has(scopeKey))) invalid(`Write-scope conflict owner has no overlapping scope: ${blocked.workOrderId}`);
}

function invalid(message: string): never {
  throw new HarnessError("TRACE_INVALID", message);
}
