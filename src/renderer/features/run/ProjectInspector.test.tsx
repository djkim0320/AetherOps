/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { shellQueryKeys } from "../../domain/queryKeys.js";
import { ProjectInspector } from "./ProjectInspector.js";

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = TestResizeObserver;

describe("ProjectInspector item deep links", () => {
  it("highlights and describes the selected evidence item and emits item navigation", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(shellQueryKeys.projects.snapshot("project-1"), {
      projectId: "project-1",
      revision: 1,
      execution: { status: "idle", currentStep: "create_research_db", revision: 1 },
      updatedAt: "2026-07-10T00:00:00.000Z",
      data: { evidence: [{ id: "evidence-1", title: "Wind tunnel result", summary: "Measured lift." }] }
    });
    client.setQueryData(shellQueryKeys.projects.jobs("project-1"), { jobs: [] });
    const onSelectItem = vi.fn();

    render(
      <QueryClientProvider client={client}>
        <ProjectInspector projectId="project-1" selected="evidence" selectedItemId="evidence-1" onSelect={vi.fn()} onSelectItem={onSelectItem} />
      </QueryClientProvider>
    );

    expect(screen.getByLabelText("선택한 근거").textContent).toContain("Measured lift.");
    const item = screen.getByRole("button", { name: /Wind tunnel result/ });
    expect(item.getAttribute("aria-pressed")).toBe("true");
    await user.click(item);
    expect(onSelectItem).toHaveBeenCalledWith("evidence-1");
  });

  it("shows the selected job policy, decisions, and attempt lifecycle", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const timestamp = "2026-07-10T00:00:00.000Z";
    client.setQueryData(shellQueryKeys.projects.snapshot("project-1"), {
      projectId: "project-1",
      revision: 1,
      execution: { status: "blocked", currentStep: "EXECUTE_TOOLS", revision: 1 },
      updatedAt: timestamp,
      data: {}
    });
    client.setQueryData(shellQueryKeys.projects.jobs("project-1"), {
      jobs: [
        {
          id: "job-1",
          projectId: "project-1",
          kind: "research_loop",
          status: "blocked",
          currentStep: "EXECUTE_TOOLS",
          idempotencyKey: "key-1",
          blockedReason: "NOT_READY: Codex CLI sandbox permission profile could not be enforced.",
          createdAt: timestamp,
          updatedAt: timestamp
        }
      ]
    });
    client.setQueryData(shellQueryKeys.projects.job("project-1", "job-1"), {
      id: "job-1",
      projectId: "project-1",
      kind: "research_loop",
      status: "blocked",
      currentStep: "EXECUTE_TOOLS",
      idempotencyKey: "key-1",
      blockedReason: "NOT_READY: Codex CLI sandbox permission profile could not be enforced.",
      createdAt: timestamp,
      updatedAt: timestamp,
      requestedCapabilities: { agent: true, engineering: false, search: true },
      traceAvailability: "available",
      trace: {
        llmInvocations: [],
        toolDecisions: [
          {
            id: "decision-1",
            toolName: "WebFetchTool",
            purpose: "Fetch the pinned source.",
            expectedOutcome: "A validated source.",
            userPinned: true,
            policyStatus: "accepted",
            actionHash: "action-hash",
            actionSummary: { phase: "acquisition.fetch", ordinal: 0 },
            createdAt: timestamp
          }
        ],
        toolAttempts: [
          {
            id: "attempt-1",
            decisionId: "decision-1",
            ordinal: 0,
            status: "blocked",
            inputHash: "hash",
            dependsOnAttemptIds: [],
            terminalCause: "NOT_READY: sandbox permission profile validation failed",
            queuedAt: timestamp,
            startedAt: timestamp
          }
        ],
        codexCliExecutions: [
          {
            id: "codex-execution-1",
            attemptId: "attempt-1",
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
            sandboxProfile: "aetherops-codex-workspace-v1",
            networkPolicy: "disabled",
            terminationReason: "NOT_READY",
            eventCount: 1,
            createdAt: timestamp,
            completedAt: timestamp
          }
        ],
        outputs: [],
        networkAudits: []
      }
    });

    render(
      <QueryClientProvider client={client}>
        <ProjectInspector projectId="project-1" selected="run" selectedItemId="job-1" onSelect={vi.fn()} onSelectItem={vi.fn()} />
      </QueryClientProvider>
    );

    expect(screen.getByLabelText("선택한 실행 추적").textContent).toContain("WebFetchTool");
    expect(screen.getByLabelText("선택한 실행 추적").textContent).toContain("차단 사유:");
    expect(screen.getByLabelText("선택한 실행 추적").textContent).toContain("NOT_READY");
    expect(screen.getByLabelText("선택한 실행 추적").textContent).toContain("#0 차단됨");
    expect(screen.getByLabelText("Codex CLI 실행").textContent).toContain("aetherops-codex-workspace-v1");
    expect(screen.getByLabelText("Codex CLI 실행").textContent).toContain("네트워크 꺼짐");
    expect(screen.getByLabelText("선택한 실행 추적").textContent).toContain("엔지니어링 꺼짐");
  });
});
