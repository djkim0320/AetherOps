import { describe, expect, it, vi } from "vitest";
import { ToolRunner, ToolRunnerError } from "../../../src/core/tools/toolRunner.js";
import { validateAirfoilCoordinateText } from "../../../src/server/runtime/engineering/engineeringProgramCoordinateResolver.js";
import { PdfIngestionTool } from "../../../src/server/runtime/tools/pdfIngestionTool.js";
import { WebFetchTool } from "../../../src/server/runtime/tools/webFetchTool.js";
import { CLARK_Y_COORDINATES, installToolRunnerTestCleanup, runInput, settings, webSource } from "./toolRunner.integration.support.js";

installToolRunnerTestCleanup();

describe("WebFetch security and content handling", () => {
  it("accepts text-like coordinate files when servers omit content type", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("Clark Y coordinates", "https://93.184.216.34/clarky.dat")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url,
        headers: new Headers(),
        body: undefined,
        arrayBuffer: async () => new TextEncoder().encode(CLARK_Y_COORDINATES).buffer
      }))
    );

    const result = await new WebFetchTool().run(input, settings);
    const rawText = result.sources[0]?.metadata.rawText;

    expect(result.toolRun.status).toBe("completed");
    expect(result.sources[0]).toMatchObject({
      title: "https://93.184.216.34/clarky.dat",
      url: "https://93.184.216.34/clarky.dat"
    });
    expect(rawText).toContain("\n 0.0000000 0.0000000\n");
    expect(() => validateAirfoilCoordinateText(String(rawText))).not.toThrow();
    expect(result.evidence[0]?.quote).toContain("CLARK Y AIRFOIL");
  });

  it("returns a failed tool run when every selected URL fails so ToolRunner rejects it", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("s1", "https://example.edu/fail")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({ ok: false, status: 503, statusText: "Unavailable", url, headers: new Headers(), text: async () => "" }))
    );

    const result = await new WebFetchTool().run(input, settings);
    expect(result.toolRun.status).toBe("failed");
    await expect(new ToolRunner([new WebFetchTool()]).execute(input, settings)).rejects.toBeInstanceOf(ToolRunnerError);
  });

  it("blocks WebFetchTool direct runs when external search is disabled", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("s1", "https://example.edu/a")] };
    await expect(new WebFetchTool().run(input, { ...settings, allowExternalSearch: false })).rejects.toThrow("external network access");
  });

  it("blocks private or local fetch targets before calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const blockedUrls = ["http://localhost:3000", "http://127.0.0.1", "http://169.254.169.254"];

    const result = await new WebFetchTool().run(
      { ...runInput(["WebFetchTool"]), sources: blockedUrls.map((url, index) => webSource(`blocked-${index}`, url)) },
      settings
    );

    expect(result.toolRun.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.toolRun.output).toMatchObject({ failedUrls: blockedUrls });
  });

  it("blocks IPv6 private, loopback, unspecified, and multicast fetch targets before calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const blockedUrls = ["http://[::1]", "http://[::]", "http://[fc00::1]"];

    const result = await new WebFetchTool().run(
      { ...runInput(["WebFetchTool"]), sources: blockedUrls.map((url, index) => webSource(`blocked-${index}`, url)) },
      settings
    );

    expect(result.toolRun.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.toolRun.output).toMatchObject({ failedUrls: blockedUrls });
  });

  it("blocks IPv6 link-local and multicast fetch targets before calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const blockedUrls = ["http://[fe80::1]", "http://[ff02::1]"];

    const result = await new WebFetchTool().run(
      { ...runInput(["WebFetchTool"]), sources: blockedUrls.map((url, index) => webSource(`blocked-v6-${index}`, url)) },
      settings
    );

    expect(result.toolRun.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.toolRun.output).toMatchObject({ failedUrls: blockedUrls });
  });

  it("records body read timeout for slow HTML response streams", async () => {
    vi.useFakeTimers();
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("slow", "https://93.184.216.34/slow")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url,
        headers: new Headers({ "content-type": "text/html" }),
        body: {
          getReader: () => ({
            read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
            cancel: () => Promise.resolve()
          })
        }
      }))
    );

    const pending = new WebFetchTool().run(input, settings);
    await vi.advanceTimersByTimeAsync(10_050);
    const result = await pending;

    expect(result.toolRun.status).toBe("failed");
    expect((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons["https://93.184.216.34/slow"]).toContain("body read timeout");
  });

  it("records PDF body read timeout for slow PDF streams", async () => {
    vi.useFakeTimers();
    const input = {
      ...runInput(["PdfIngestionTool"]),
      researchPlan: { ...runInput(["PdfIngestionTool"]).researchPlan!, fetchCandidateUrls: ["https://93.184.216.34/paper.pdf"] }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url,
        headers: new Headers({ "content-type": "application/pdf" }),
        body: {
          getReader: () => ({
            read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
            cancel: () => Promise.resolve()
          })
        }
      }))
    );

    const pending = new PdfIngestionTool().run(input, settings);
    await vi.advanceTimersByTimeAsync(10_050);
    const result = await pending;

    expect(result.toolRun.status).toBe("failed");
    expect((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons["https://93.184.216.34/paper.pdf"]).toContain(
      "body read timeout"
    );
  });

  it("decodes Korean legacy charset pages without mojibake", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("korean", "https://93.184.216.34/korean")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Uint8Array.from([0xc7, 0xd1, 0xb1, 0xdb]), {
            status: 200,
            headers: { "content-type": "text/plain; charset=euc-kr" }
          })
      )
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect(result.evidence[0]?.quote).toContain("\uD55C\uAE00");
    expect(result.evidence[0]?.quote).not.toMatch(/[?]{2,}|\uFFFD/);
  });

  it("uses HTML meta charset when content-type has no charset", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("korean-meta", "https://93.184.216.34/korean-meta")] };
    const prefix = new TextEncoder().encode('<html><head><meta charset="cp949"></head><body>');
    const suffix = new TextEncoder().encode("</body></html>");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Uint8Array.from([...prefix, 0xc7, 0xd1, 0xb1, 0xdb, ...suffix]), {
            status: 200,
            headers: { "content-type": "text/html" }
          })
      )
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect(result.evidence[0]?.quote).toContain("\uD55C\uAE00");
    expect(result.evidence[0]?.quote).not.toMatch(/[?]{2,}|\uFFFD/);
  });

  it("decodes common Korean charset aliases across split stream chunks", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("korean-ms949", "https://93.184.216.34/korean-ms949")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Uint8Array.from([0xc7]));
                controller.enqueue(Uint8Array.from([0xd1, 0xb1]));
                controller.enqueue(Uint8Array.from([0xdb]));
                controller.close();
              }
            }),
            {
              status: 200,
              headers: { "content-type": "text/plain; charset=ms949" }
            }
          )
      )
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect(result.evidence[0]?.quote).toContain("\uD55C\uAE00");
    expect(result.evidence[0]?.quote).not.toMatch(/[?]{2,}|\uFFFD/);
  });

  it("uses x-windows-949 HTML meta charset aliases", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("korean-meta-alias", "https://93.184.216.34/korean-meta-alias")] };
    const prefix = new TextEncoder().encode('<html><head><meta charset="x-windows-949"></head><body>');
    const suffix = new TextEncoder().encode("</body></html>");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Uint8Array.from([...prefix, 0xc7, 0xd1, 0xb1, 0xdb, ...suffix]), {
            status: 200,
            headers: { "content-type": "text/html" }
          })
      )
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect(result.evidence[0]?.quote).toContain("\uD55C\uAE00");
    expect(result.evidence[0]?.quote).not.toMatch(/[?]{2,}|\uFFFD/);
  });

  it("fails closed for unsupported or invalid text encodings without creating evidence", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      sources: [
        webSource("unsupported-charset", "https://example.com/unsupported-charset"),
        webSource("missing-charset", "https://example.com/missing-charset"),
        webSource("replacement", "https://example.com/replacement")
      ]
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("unsupported")) {
          return new Response("hello", { status: 200, headers: { "content-type": "text/plain; charset=made-up-charset" } });
        }
        if (url.includes("missing")) {
          return new Response(Uint8Array.from([0xc7, 0xd1, 0xb1, 0xdb]), { status: 200, headers: { "content-type": "text/plain" } });
        }
        return new Response("bad \uFFFD text", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
      })
    );

    const result = await new WebFetchTool().run(input, settings);
    const failureReasons = (result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons;

    expect(result.toolRun.status).toBe("failed");
    expect(result.evidence).toHaveLength(0);
    expect(failureReasons["https://example.com/unsupported-charset"]).toContain("unsupported charset");
    expect(failureReasons["https://example.com/missing-charset"]).toContain("invalid text encoding");
    expect(failureReasons["https://example.com/replacement"]).toContain("replacement characters");
  });

  it("rejects oversized and non-text responses without creating evidence", async () => {
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("s1", "https://example.com/huge"), webSource("s2", "https://example.com/image")] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        url,
        headers: url.includes("huge")
          ? new Headers({ "content-type": "text/html", "content-length": String(2 * 1024 * 1024 + 1) })
          : new Headers({ "content-type": "image/png" }),
        text: async () => "should not become evidence"
      }))
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("failed");
    expect(result.evidence).toHaveLength(0);
    expect(Object.values((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons).join(" ")).toMatch(
      /content-length|content-type/
    );
  });
});
