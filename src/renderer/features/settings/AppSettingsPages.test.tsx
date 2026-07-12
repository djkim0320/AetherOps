/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { shellQueryKeys } from "../../domain/queryKeys.js";
import { ToolsPage } from "./AppSettingsPages.js";

describe("Tools diagnostics page", () => {
  it("shows Codex CLI sandbox readiness and fail-closed NOT_READY guidance", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(shellQueryKeys.toolsDiagnostics(), {
      capabilities: { agent: true, engineering: true, search: false },
      tools: [
        {
          name: "CodexCliTool",
          category: "agent",
          status: "ready",
          reason:
            "Filesystem and network sandbox enforcement is verified at execution. A failed permission-profile check blocks the job with NOT_READY; no fallback is used."
        }
      ],
      generatedAt: "2026-07-10T00:00:00.000Z"
    });

    render(
      <MemoryRouter initialEntries={["/settings/tools"]}>
        <QueryClientProvider client={client}>
          <ToolsPage />
        </QueryClientProvider>
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: "CodexCliTool" })).toBeTruthy();
    expect(screen.getByText(/NOT_READY/).textContent).toContain("no fallback");
  });
});
