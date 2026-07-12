/* @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatComposer } from "./ChatComposer.js";

describe("ChatComposer", () => {
  it("submits with Enter and keeps Shift+Enter for multiline input", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onDraftChange = vi.fn();
    const { rerender } = render(<ChatComposer draft="Research this" sending={false} onDraftChange={onDraftChange} onSubmit={onSubmit} />);
    const textbox = screen.getByRole("textbox", { name: "메시지" });

    await user.type(textbox, "{Shift>}{Enter}{/Shift}");
    expect(onSubmit).not.toHaveBeenCalled();

    rerender(<ChatComposer draft="Research this" sending={false} onDraftChange={onDraftChange} onSubmit={onSubmit} />);
    await user.type(screen.getByRole("textbox", { name: "메시지" }), "{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("does not send while an IME composition is active", () => {
    const onSubmit = vi.fn();
    render(<ChatComposer draft="연구 질문" sending={false} onDraftChange={vi.fn()} onSubmit={onSubmit} />);
    const textbox = screen.getByRole("textbox", { name: "메시지" });

    textbox.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSubmit).not.toHaveBeenCalled();

    textbox.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    textbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("exposes failure feedback and disables empty submissions", () => {
    render(<ChatComposer draft=" " sending={false} error={new Error("Queue unavailable")} onDraftChange={vi.fn()} onSubmit={vi.fn()} />);

    expect((screen.getByRole("button", { name: "메시지 보내기" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("작업 큐를 사용할 수 없습니다.");
  });
});
