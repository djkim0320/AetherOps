import { z } from "zod";
import { callRpc } from "./rpcTransport.js";

describe("RPC mutation transport retries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reuses the exact request id and body after a project mutation response is lost", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(jsonResponse({ result: { id: "project-recovered" } }));
    vi.stubGlobal("fetch", fetch);

    await expect(callRpc("projects.create", { input: { topic: "retry" } }, z.object({ id: z.string() }))).resolves.toEqual({
      id: "project-recovered"
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const first = requestBody(fetch, 0);
    const second = requestBody(fetch, 1);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ method: "projects.create", params: { input: { topic: "retry" } } });
    expect(first.requestId).toEqual(expect.any(String));
  });

  it("does not retry a read with a fresh request id after a transport failure", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetch);

    await expect(callRpc("projects.get", { projectId: "project-1" }, z.unknown())).rejects.toThrow("offline");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function requestBody(fetch: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const init = fetch.mock.calls[index]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== "string") throw new Error("Expected an RPC request body.");
  return JSON.parse(init.body) as Record<string, unknown>;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
