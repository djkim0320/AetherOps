/* @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceHeader } from "./WorkspaceHeader.js";

describe("WorkspaceHeader", () => {
  it("presents task context and explicit shell controls", async () => {
    const user = userEvent.setup();
    const onToggleRail = vi.fn();
    const onToggleTheme = vi.fn();
    const onToggleInspector = vi.fn();

    render(
      <WorkspaceHeader
        context="Project workspace"
        title="Research task"
        railCollapsed={false}
        inspectorAvailable
        inspectorVisible
        theme="dark"
        onToggleRail={onToggleRail}
        onToggleTheme={onToggleTheme}
        onToggleInspector={onToggleInspector}
      />
    );

    expect(screen.getByText("Research task")).toBeTruthy();
    expect(screen.getByText("Project workspace")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "프로젝트 사이드바 접기" }));
    await user.click(screen.getByRole("button", { name: "라이트 테마 사용" }));
    await user.click(screen.getByRole("button", { name: "인스펙터 숨기기" }));
    expect(onToggleRail).toHaveBeenCalledOnce();
    expect(onToggleTheme).toHaveBeenCalledOnce();
    expect(onToggleInspector).toHaveBeenCalledOnce();
  });

  it("omits the inspector control outside project routes", () => {
    render(
      <WorkspaceHeader
        context="AetherOps"
        title="Settings"
        railCollapsed
        inspectorAvailable={false}
        inspectorVisible={false}
        theme="light"
        onToggleRail={vi.fn()}
        onToggleTheme={vi.fn()}
        onToggleInspector={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: /inspector/i })).toBeNull();
    expect(screen.getByRole("button", { name: "프로젝트 사이드바 펼치기" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "다크 테마 사용" })).toBeTruthy();
  });
});
