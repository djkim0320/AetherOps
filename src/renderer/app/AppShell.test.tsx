/* @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AppProviders } from "./AppProviders.js";
import { AppShell } from "./AppShell.js";

vi.mock("../features/navigation/public.js", () => ({
  ProjectRail: ({ projectId }: { projectId?: string }) => <aside data-testid="project-rail">{projectId}</aside>
}));

vi.mock("../features/run/public.js", () => ({
  RunBar: ({ projectId }: { projectId: string }) => <div data-testid="run-bar">{projectId}</div>,
  ProjectInspector: ({ projectId, selectedItemId, onSelectItem }: { projectId: string; selectedItemId?: string; onSelectItem: (id: string) => void }) => (
    <aside data-testid="project-inspector">
      {projectId}:{selectedItemId}
      <button type="button" onClick={() => onSelectItem("artifact-7")}>
        Select artifact
      </button>
    </aside>
  )
}));

vi.mock("./ProjectEventsBridge.js", () => ({
  ProjectEventsBridge: ({ projectId }: { projectId: string }) => <div data-testid="events-bridge">{projectId}</div>
}));

describe("AppShell project route integration", () => {
  it("mounts project live state and inspectors for a nested chat route", async () => {
    const router = createMemoryRouter(
      [
        {
          element: <AppShell />,
          children: [
            {
              path: "projects/:projectId/chats/:sessionId",
              element: <main data-testid="chat-route">Chat</main>
            }
          ]
        }
      ],
      { initialEntries: ["/projects/project-42/chats/session-9?inspector=evidence&item=evidence-3"] }
    );

    render(
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    );

    expect(await screen.findByTestId("chat-route")).toBeTruthy();
    expect(screen.getByTestId("events-bridge").textContent).toBe("project-42");
    expect(screen.getByTestId("run-bar").textContent).toBe("project-42");
    expect(screen.getByTestId("project-rail").textContent).toBe("project-42");
    expect(screen.getByTestId("project-inspector").textContent).toContain("project-42:evidence-3");
    fireEvent.click(screen.getByRole("button", { name: "Select artifact" }));
    await waitFor(() => expect(router.state.location.search).toContain("item=artifact-7"));
  });

  it("does not mount project-only modules on app settings routes", async () => {
    const router = createMemoryRouter(
      [
        {
          element: <AppShell />,
          children: [{ path: "settings/codex", element: <main data-testid="settings-route">Settings</main> }]
        }
      ],
      { initialEntries: ["/settings/codex"] }
    );

    render(
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    );

    expect(await screen.findByTestId("settings-route")).toBeTruthy();
    expect(screen.queryByTestId("events-bridge")).toBeNull();
    expect(screen.queryByTestId("run-bar")).toBeNull();
    expect(screen.queryByTestId("project-inspector")).toBeNull();
  });
});
