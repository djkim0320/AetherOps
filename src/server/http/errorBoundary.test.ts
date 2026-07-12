import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerRequestId, internalErrorMessage, logInternalError } from "./errorBoundary.js";

afterEach(() => vi.restoreAllMocks());

describe("HTTP internal error boundary", () => {
  it("creates contract-safe server request IDs", () => {
    expect(createServerRequestId()).toMatch(/^srv-[0-9a-f-]{36}$/);
    expect(internalErrorMessage).toBe("The request could not be completed.");
  });

  it.each([new Error("token=super-secret at C:\\Users\\alice\\private.txt"), "password=hunter2 at /home/alice/private.txt"])(
    "logs a structured redacted diagnostic for %s",
    (error) => {
      const output = vi.spyOn(console, "error").mockImplementation(() => undefined);

      logInternalError(error, { requestId: "srv-test", operation: "POST /api/v2/rpc", startedAt: Date.now() - 5 });

      expect(output).toHaveBeenCalledOnce();
      const logged = output.mock.calls[0]?.[0] as string;
      expect(JSON.parse(logged)).toMatchObject({ requestId: "srv-test", operation: "POST /api/v2/rpc" });
      expect(logged).not.toMatch(/super-secret|hunter2|alice|private\.txt/);
    }
  );

  it("redacts a nested Error cause chain", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cause = new Error("api_key=sk-hidden-provider-key");

    logInternalError(new Error("provider failed", { cause }), { requestId: "srv-cause", operation: "rpc", startedAt: Date.now() });

    const logged = output.mock.calls[0]?.[0] as string;
    expect(logged).toContain("provider failed");
    expect(logged).not.toContain("sk-hidden-provider-key");
  });
});
