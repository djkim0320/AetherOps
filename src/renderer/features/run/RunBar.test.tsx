/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { shellQueryKeys } from "../../domain/queryKeys.js";
import { RunBar } from "./RunBar.js";

const { start } = vi.hoisted(() => ({ start: vi.fn().mockResolvedValue({ jobId: "job-1" }) }));

vi.mock("../../domain/jobApi.js", () => ({
  jobApi: {
    start,
    pause: vi.fn(),
    resume: vi.fn(),
    abort: vi.fn(),
    list: vi.fn().mockResolvedValue({ jobs: [] })
  }
}));

describe("RunBar research policy", () => {
  it("sends explicit project capabilities and keeps Codex workspace execution disabled by default", async () => {
    const user = userEvent.setup();
    const projectId = "project-1";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(shellQueryKeys.projects.detail(projectId), {
      id: projectId,
      capabilities: { agent: true, engineering: true, search: false }
    });
    client.setQueryData(shellQueryKeys.projects.snapshot(projectId), {
      projectId,
      revision: 1,
      execution: { status: "idle", currentStep: "CREATE_RESEARCH_DB", revision: 1 },
      updatedAt: "2026-07-10T00:00:00.000Z",
      data: {}
    });
    client.setQueryData(shellQueryKeys.projects.jobs(projectId), { jobs: [] });
    client.setQueryData(shellQueryKeys.settings(), {
      capabilities: { agent: true, engineering: true, search: true }
    });

    render(
      <QueryClientProvider client={client}>
        <RunBar projectId={projectId} />
      </QueryClientProvider>
    );

    await user.click(screen.getByRole("button", { name: "시작" }));
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Codex 워크스페이스 실행 허용" }).getAttribute("aria-checked")).toBe("false");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "시작" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start).toHaveBeenCalledWith({
      projectId,
      idempotencyKey: expect.any(String),
      requestedCapabilities: { agent: true, engineering: true, search: false },
      toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
    });
  });

  it("shows the persisted blocked reason without removing its keyboard-accessible action", async () => {
    const user = userEvent.setup();
    const projectId = "project-blocked";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(shellQueryKeys.projects.detail(projectId), {
      id: projectId,
      capabilities: { agent: true, engineering: true, search: false }
    });
    client.setQueryData(shellQueryKeys.projects.snapshot(projectId), {
      projectId,
      revision: 4,
      execution: { status: "blocked", currentStep: "EXECUTE_TOOLS", lastCheckpointId: "checkpoint-1", revision: 4 },
      updatedAt: "2026-07-10T00:00:00.000Z",
      data: {}
    });
    client.setQueryData(shellQueryKeys.projects.jobs(projectId), {
      jobs: [
        {
          id: "job-blocked",
          projectId,
          kind: "research_loop",
          status: "blocked",
          currentStep: "EXECUTE_TOOLS",
          idempotencyKey: "blocked-key",
          blockedReason: "NOT_READY: Codex CLI permission profile is not enforceable on this Windows host.",
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z"
        }
      ]
    });
    client.setQueryData(shellQueryKeys.settings(), { capabilities: { agent: true, engineering: true, search: false } });

    render(
      <QueryClientProvider client={client}>
        <RunBar projectId={projectId} />
      </QueryClientProvider>
    );

    expect(screen.getByRole("alert").textContent).toContain("실행 차단됨");
    expect(screen.getByRole("alert").textContent).toContain("NOT_READY");
    expect(screen.getByRole("alert").textContent).toContain("permission profile is not enforceable");
    const alert = screen.getByRole("alert");
    const runBar = alert.closest('[data-ui="run-bar"]');
    expect(runBar).not.toBeNull();
    expect(alert.parentElement).toBe(runBar?.firstElementChild);
    expect(alert.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const resume = screen.getByRole("button", { name: "재개" });
    await user.tab();
    expect(document.activeElement).toBe(resume);
  });
});
