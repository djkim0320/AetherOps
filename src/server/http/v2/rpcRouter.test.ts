import { describe, expect, it, vi } from "vitest";
import type { RpcHandlerContext } from "./context.js";
import { handleRpcV2, RpcV2Error, RpcValidationError } from "./rpcRouter.js";

describe("RPC v2 error mapping", () => {
  it.each([
    new Error("token=secret-provider-response at C:\\private\\file.txt"),
    "password=secret-string",
    new Error("outer provider failure", { cause: new Error("api_key=secret-cause") })
  ])("does not expose an unexpected failure: %s", async (failure) => {
    const context = contextWithSettingsFailure(failure);

    const error = await handleRpcV2({ requestId: "request-safe-1", method: "settings.get", params: {} }, context).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RpcV2Error);
    expect(error).toMatchObject({
      status: 500,
      requestId: "request-safe-1",
      code: "INTERNAL_ERROR",
      message: "The request could not be completed."
    });
    expect(JSON.stringify(error)).not.toMatch(/secret-provider|secret-string|secret-cause|private/);
  });

  it("preserves useful known validation errors", async () => {
    const context = contextWithSettingsFailure(new RpcValidationError("The selected value is invalid.", { field: "model" }));

    const error = await handleRpcV2({ requestId: "request-known-1", method: "settings.get", params: {} }, context).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "The selected value is invalid.",
      details: { field: "model" }
    });
  });
});

function contextWithSettingsFailure(failure: unknown): RpcHandlerContext {
  return {
    settingsStore: { getRuntimeSettings: vi.fn().mockRejectedValue(failure) }
  } as unknown as RpcHandlerContext;
}
