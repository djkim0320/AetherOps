import { describe, expect, it, vi } from "vitest";
import { toSnapshotResponse } from "./projectResponses.js";
import { handleRpcV2 } from "./rpcRouter.js";
import { job, researchEnqueueContext } from "./rpcRouterTestSupport.js";
import { ProjectMutationNotReadyError, ProjectMutationReadRaceError } from "../../composition/projectMutationSagaCoordinator.js";

describe("RPC v2 durable project revision", () => {
  it("routes project creation through the durable mutation coordinator", async () => {
    const context = researchEnqueueContext(vi.fn());
    vi.mocked(context.projectMutations.create).mockResolvedValue({
      id: "project-1",
      input: { goal: "goal", topic: "topic", scope: "scope", budget: "budget" },
      capabilities: { agent: true, engineering: false, search: false },
      execution: { status: "idle", currentStep: "CREATE_RESEARCH_DB", revision: 1 },
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z"
    });

    const response = await handleRpcV2(
      {
        requestId: "request-create-projection",
        method: "projects.create",
        params: { input: { goal: "goal", topic: "topic", scope: "scope", budget: "budget" } }
      },
      context
    );

    expect(context.projectMutations.create).toHaveBeenCalledWith("request-create-projection", {
      goal: "goal",
      topic: "topic",
      scope: "scope",
      budget: "budget"
    });
    expect(context.jobs.commitProjectSnapshot).not.toHaveBeenCalled();
    expect(response).toMatchObject({ result: { id: "project-1", execution: { revision: 1 } } });
  });

  it("uses the durable project head for project and snapshot responses", async () => {
    const context = researchEnqueueContext(vi.fn());
    context.jobs.getProjectRevision = vi.fn().mockResolvedValue(23);
    context.orchestrator.listProjects = vi.fn().mockResolvedValue([(await context.orchestrator.getSnapshot("project-1")).project]);
    context.jobs.latestProjectExecution = vi.fn().mockResolvedValue({
      job: { ...job("project-1", 4), id: "job-current", status: "paused" },
      checkpoint: undefined
    });

    const [project, projects, snapshot] = await Promise.all([
      handleRpcV2({ requestId: "request-project-head", method: "projects.get", params: { projectId: "project-1" } }, context),
      handleRpcV2({ requestId: "request-project-list-head", method: "projects.list", params: {} }, context),
      handleRpcV2({ requestId: "request-snapshot-head", method: "snapshots.get", params: { projectId: "project-1" } }, context)
    ]);

    expect(project).toMatchObject({ result: { execution: { revision: 23 } } });
    expect(projects).toMatchObject({ result: [{ execution: { revision: 23 } }] });
    expect(snapshot).toMatchObject({ result: { revision: 23, execution: { revision: 23, activeJobId: "job-current" } } });
  });

  it("does not allow an execution patch to override the durable snapshot revision", async () => {
    const context = researchEnqueueContext(vi.fn());
    const snapshot = await context.orchestrator.getSnapshot("project-1");

    const response = toSnapshotResponse(snapshot, 9, { status: "paused", revision: 2 } as never);

    expect(response).toMatchObject({ revision: 9, execution: { status: "paused", revision: 9 } });
  });

  it("fails project reads explicitly when the durable revision head is unavailable", async () => {
    const context = researchEnqueueContext(vi.fn());
    context.jobs.getProjectRevision = vi.fn().mockResolvedValue(undefined);
    vi.mocked(context.projectMutations.readSnapshot).mockRejectedValue(new ProjectMutationNotReadyError("project-1"));

    const error = await handleRpcV2({ requestId: "request-project-head-missing", method: "projects.get", params: { projectId: "project-1" } }, context).catch(
      (caught: unknown) => caught
    );

    expect(error).toMatchObject({ status: 503, code: "NOT_READY", details: { reason: "PROJECT_REVISION_UNAVAILABLE" } });
  });

  it("does not label an old snapshot with a revision committed during execution projection", async () => {
    const context = researchEnqueueContext(vi.fn());
    vi.mocked(context.projectMutations.assertRevisionUnchanged).mockRejectedValue(new ProjectMutationReadRaceError("project-1"));
    context.jobs.latestProjectExecution = vi.fn().mockResolvedValue({ job: undefined, checkpoint: undefined });

    const error = await handleRpcV2({ requestId: "request-snapshot-read-race", method: "snapshots.get", params: { projectId: "project-1" } }, context).catch(
      (caught: unknown) => caught
    );

    expect(error).toMatchObject({ status: 503, code: "NOT_READY", details: { reason: "PROJECT_SNAPSHOT_CHANGED", projectId: "project-1" } });
  });

  it("returns the coordinator result after a project update", async () => {
    const context = researchEnqueueContext(vi.fn());
    const current = await context.orchestrator.getSnapshot("project-1");
    const updated = { ...current, project: { ...current.project, goal: "Updated goal", updatedAt: "2026-07-14T00:01:00.000Z" } };
    vi.mocked(context.projectMutations.update).mockResolvedValue({
      id: "project-1",
      input: { goal: "Updated goal", topic: updated.project.topic, scope: updated.project.scope, budget: updated.project.budget },
      capabilities: { agent: true, engineering: false, search: false },
      execution: { status: "idle", currentStep: updated.project.currentStep, revision: 8 },
      createdAt: updated.project.createdAt,
      updatedAt: updated.project.updatedAt
    });

    const response = await handleRpcV2(
      {
        requestId: "request-project-update-head",
        method: "projects.update",
        params: { projectId: "project-1", expectedRevision: 7, input: { goal: "Updated goal" } }
      },
      context
    );

    expect(response).toMatchObject({ result: { execution: { revision: 8 } } });
    expect(context.projectMutations.update).toHaveBeenCalledWith("request-project-update-head", "project-1", 7, { goal: "Updated goal" }, undefined);
    expect(context.jobs.commitProjectSnapshot).not.toHaveBeenCalled();
  });

  it("commits session creation and deletion against the durable project head", async () => {
    const context = researchEnqueueContext(vi.fn());
    vi.mocked(context.projectMutations.createSession).mockResolvedValue({
      id: "session-new",
      projectId: "project-1",
      title: "New chat",
      focus: "Focus",
      createdAt: "2026-07-14T00:01:00.000Z",
      updatedAt: "2026-07-14T00:01:00.000Z"
    });
    vi.mocked(context.projectMutations.deleteSession).mockResolvedValue({ deleted: true });

    const createResponse = await handleRpcV2(
      { requestId: "request-session-create-head", method: "sessions.create", params: { projectId: "project-1", title: "New chat", focus: "Focus" } },
      context
    );
    const deleteResponse = await handleRpcV2(
      { requestId: "request-session-delete-head", method: "sessions.delete", params: { projectId: "project-1", sessionId: "session-new" } },
      context
    );

    expect(createResponse).toMatchObject({ result: { id: "session-new" } });
    expect(deleteResponse).toMatchObject({ result: { deleted: true } });
    expect(context.projectMutations.createSession).toHaveBeenCalledWith("request-session-create-head", "project-1", "New chat", "Focus");
    expect(context.projectMutations.deleteSession).toHaveBeenCalledWith("request-session-delete-head", "project-1", "session-new");
    expect(context.jobs.commitProjectSnapshot).not.toHaveBeenCalled();
  });
});
