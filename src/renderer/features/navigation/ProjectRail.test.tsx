/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ProjectSummary } from "../../../contracts/api-v2/projects.js";
import { shellQueryKeys } from "../../domain/queryKeys.js";
import { ProjectRail } from "./ProjectRail.js";

const baseProject: ProjectSummary = {
  id: "project-older",
  input: { topic: "Wing study", goal: "Compare lift", scope: "Clark Y", budget: "Local" },
  capabilities: { agent: true, engineering: true, search: false },
  execution: { status: "idle", currentStep: "PLAN_RESEARCH", revision: 1 },
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z"
};

function renderRail(projects: ProjectSummary[], projectId?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(shellQueryKeys.projects.all(), projects);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProjectRail collapsed={false} projectId={projectId} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ProjectRail", () => {
  it("sorts recent projects, exposes execution state, and marks the current workspace", () => {
    const running: ProjectSummary = {
      ...baseProject,
      id: "project-current",
      input: { ...baseProject.input, topic: "Recent autonomy run" },
      execution: { ...baseProject.execution, status: "running" },
      updatedAt: "2026-07-10T00:00:00.000Z"
    };
    renderRail([baseProject, running], running.id);

    const projectLinks = screen.getAllByRole("link").filter((link) => link.getAttribute("href")?.includes("/chats/new"));
    expect(projectLinks[1]?.textContent).toContain("Recent autonomy run");
    expect(screen.getByText("실행 중")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Recent autonomy run/ }).getAttribute("aria-current")).toBe("page");
  });

  it("filters work by topic or goal", async () => {
    const user = userEvent.setup();
    renderRail([baseProject, { ...baseProject, id: "project-second", input: { ...baseProject.input, topic: "Ontology", goal: "Map evidence" } }]);

    await user.type(screen.getByRole("textbox", { name: "프로젝트 검색" }), "evidence");
    expect(screen.getByText("Ontology")).toBeTruthy();
    expect(screen.queryByText("Wing study")).toBeNull();
  });
});
