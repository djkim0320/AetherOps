import { describe, expect, it } from "vitest";
import { durableFailureFrom } from "./durableFailure.js";
import { publicTerminalReason } from "./durableJobExecutor.js";

describe("durable failure boundary", () => {
  it("removes credentials, paths, provider output, prompts, and nested causes", () => {
    const cause = new Error("Authorization: Basic dXNlcjpwYXNz Cookie: session=very-secret C:\\Users\\alice\\private.txt /home/alice/private.txt");
    const error = new Error("provider response: raw model output\nprompt: private user research text\napi_key=sk-secret-value", { cause });
    const failure = durableFailureFrom(error, { diagnosticId: () => "diag-fixed" });
    const serialized = JSON.stringify(failure);

    expect(failure).toMatchObject({
      code: "INTERNAL_ERROR",
      publicMessage: "작업 실행 중 내부 오류가 발생했습니다.",
      retriable: false,
      internalDiagnosticId: "diag-fixed"
    });
    for (const secret of ["dXNlcjpwYXNz", "very-secret", "alice", "raw model output", "private user research text", "sk-secret-value"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("preserves only explicitly safe public failures", () => {
    const failure = durableFailureFrom(new Error("ignored raw provider text"), {
      code: "NOT_READY",
      publicMessage: "Codex 인증이 필요합니다.",
      retriable: true,
      diagnosticId: () => "diag-safe"
    });
    expect(failure).toEqual({
      code: "NOT_READY",
      publicMessage: "Codex 인증이 필요합니다.",
      retriable: true,
      internalDiagnosticId: "diag-safe"
    });
  });

  it("does not treat a handler-provided terminal reason as trusted public text", () => {
    const untrusted = "Bearer secret-token provider response: prompt text C:\\Users\\alice\\secret.txt";

    expect(publicTerminalReason("blocked", untrusted)).toBe("작업 실행에 필요한 기능이 준비되지 않았습니다.");
    expect(publicTerminalReason("failed", untrusted)).toBe("작업 실행 중 내부 오류가 발생했습니다.");
  });
});
