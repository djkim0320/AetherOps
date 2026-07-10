/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { shellQueryKeys } from "../../domain/queryKeys.js";
import { ProjectInspector } from "./ProjectInspector.js";

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = TestResizeObserver;

describe("ProjectInspector item deep links", () => {
  it("highlights and describes the selected evidence item and emits item navigation", () => {
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

    expect(screen.getByLabelText("Selected evidence").textContent).toContain("Measured lift.");
    const item = screen.getByRole("button", { name: /Wind tunnel result/ });
    expect(item.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(item);
    expect(onSelectItem).toHaveBeenCalledWith("evidence-1");
  });
});
