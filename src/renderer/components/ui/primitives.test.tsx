/* @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Button } from "./button.js";
import { OrbitMark } from "./orbit-mark.js";
import { Switch } from "./switch.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = TestResizeObserver;

describe("UI primitives", () => {
  it("keeps buttons safe for form composition and exposes icon styling hooks", () => {
    render(
      <Button aria-label="Open menu" size="icon" variant="ghost">
        +
      </Button>
    );

    const button = screen.getByRole("button", { name: "Open menu" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.classList.contains("ui-button")).toBe(true);
    expect(button.getAttribute("data-size")).toBe("icon");
    expect(button.hasAttribute("data-icon-only")).toBe(true);
  });

  it("uses native switch form and reset semantics", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <form data-testid="form">
        <Switch aria-label="Telemetry" defaultChecked name="telemetry" value="enabled" onCheckedChange={onCheckedChange} />
      </form>
    );

    const form = screen.getByTestId("form") as HTMLFormElement;
    const control = screen.getByRole("switch");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(new FormData(form).get("telemetry")).toBe("enabled");

    await user.click(control);
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
    expect(new FormData(form).has("telemetry")).toBe(false);

    fireEvent.reset(form);
    await waitFor(() => expect(control.getAttribute("aria-checked")).toBe("true"));
  });

  it("moves focus, skips disabled tabs, and activates with arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="overview">
        <TabsList aria-label="Workspace views">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="disabled" disabled>
            Disabled
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Overview panel</TabsContent>
        <TabsContent value="activity">Activity panel</TabsContent>
      </Tabs>
    );

    const overview = screen.getByRole("tab", { name: "Overview" });
    const activity = screen.getByRole("tab", { name: "Activity" });
    await user.click(overview);
    await user.keyboard("{ArrowRight}");

    await waitFor(() => expect(document.activeElement).toBe(activity));
    expect(activity.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("Activity panel");
  });

  it("supports manual tab activation", async () => {
    const user = userEvent.setup();
    render(
      <Tabs activationMode="manual" defaultValue="first">
        <TabsList aria-label="Manual views">
          <TabsTrigger value="first">First</TabsTrigger>
          <TabsTrigger value="second">Second</TabsTrigger>
        </TabsList>
        <TabsContent value="first">First panel</TabsContent>
        <TabsContent value="second">Second panel</TabsContent>
      </Tabs>
    );

    const first = screen.getByRole("tab", { name: "First" });
    const second = screen.getByRole("tab", { name: "Second" });
    await user.click(first);
    await user.keyboard("{End}");

    await waitFor(() => expect(document.activeElement).toBe(second));
    expect(first.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(second.getAttribute("aria-selected")).toBe("true"));
  });

  it("treats an unnamed orbit mark as decorative and a titled mark as an image", () => {
    const { rerender } = render(<OrbitMark data-testid="mark" />);
    const mark = screen.getByTestId("mark");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("img")).toBe(null);

    rerender(<OrbitMark title="AetherOps" />);
    expect(screen.getByRole("img", { name: "AetherOps" })).toBeTruthy();
  });
});
