/* @vitest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AppProviders } from "./AppProviders.js";
import { AppShell } from "./AppShell.js";

vi.mock("../features/navigation/public.js", () => ({
  ProjectRail: ({ projectId }: { projectId?: string }) => <aside data-testid="project-rail">{projectId}</aside>
}));

vi.mock("../features/run/public.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../features/run/public.js")>()),
  RunBar: ({ projectId }: { projectId: string }) => <div data-testid="run-bar">{projectId}</div>
}));

vi.mock("./ProjectEventsBridge.js", () => ({
  ProjectEventsBridge: ({ projectId }: { projectId: string }) => <div data-testid="events-bridge">{projectId}</div>
}));

describe("AppShell project route integration", () => {
  it("mounts project live state and inspectors for a nested chat route", async () => {
    const user = userEvent.setup();
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
    expect((await screen.findByTestId("run-bar", {}, { timeout: 10_000 })).textContent).toBe("project-42");
    expect(screen.getByTestId("project-rail").textContent).toBe("project-42");
    expect(await screen.findByLabelText("프로젝트 인스펙터", {}, { timeout: 10_000 })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: /산출물/ }));
    await waitFor(() => expect(router.state.location.search).toContain("inspector=artifacts"));
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
