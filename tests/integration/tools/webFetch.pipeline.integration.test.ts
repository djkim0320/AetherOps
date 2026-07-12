import { describe, expect, it, vi } from "vitest";
import { validateAirfoilCoordinateText } from "../../../src/server/runtime/engineering/engineeringProgramCoordinateResolver.js";
import { WebFetchTool } from "../../../src/server/runtime/tools/webFetchTool.js";
import {
  CLARK_Y_COORDINATES,
  createdAt,
  installToolRunnerTestCleanup,
  runInput,
  settings,
  successResponse,
  webSource
} from "./toolRunner.integration.support.js";

installToolRunnerTestCleanup();

describe("WebFetch acquisition pipeline", () => {
  it("verifies a direct PDF with bounded HEAD before PDF ingestion downloads the body", async () => {
    const input = {
      ...runInput(["WebFetchTool", "PdfIngestionTool"]),
      researchPlan: {
        ...runInput(["WebFetchTool", "PdfIngestionTool"]).researchPlan!,
        fetchCandidateUrls: ["https://arxiv.org/pdf/1706.03762"]
      }
    };
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("HEAD");
      expect(new Headers(init?.headers).get("user-agent")).toBe("AetherOps/0.2 research client");
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": String(3 * 1024 * 1024) }
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "https://arxiv.org/pdf/1706.03762" }),
        expect.objectContaining({ kind: "paper", url: "https://arxiv.org/pdf/1706.03762" })
      ])
    );
  });

  it("fetches web sources before evidence URLs, dedupes normalized URLs, caps at three, and reports partial failures as completed", async () => {
    const input = {
      ...runInput(),
      sources: [
        webSource("s1", "https://Example.edu/a#section"),
        webSource("s2", "https://example.edu/a"),
        { ...webSource("s3", "https://example.edu/ignored-paper"), kind: "paper" as const },
        webSource("s4", "https://example.edu/fail")
      ],
      evidence: [
        {
          id: "e1",
          projectId: "project-1",
          category: "web_source" as const,
          title: "Evidence URL",
          summary: "Summary",
          sourceUri: "https://example.edu/evidence",
          keywords: [],
          linkedHypothesisIds: [],
          createdAt
        },
        {
          id: "e2",
          projectId: "project-1",
          category: "web_source" as const,
          title: "Capped URL",
          summary: "Summary",
          sourceUri: "https://example.edu/capped",
          keywords: [],
          linkedHypothesisIds: [],
          createdAt
        }
      ]
    };
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        if (url.includes("/fail")) {
          return { ok: false, status: 500, statusText: "Nope", url, headers: new Headers(), text: async () => "" };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url,
          headers: new Headers({ "content-type": "text/html" }),
          text: async () => `<html><title>${url}</title><body>Readable text for ${url}</body></html>`
        };
      })
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect((result.toolRun.output as { urls: string[] }).urls).toEqual([
      "https://Example.edu/a#section",
      "https://example.edu/fail",
      "https://example.edu/evidence"
    ]);
    expect(fetched).toEqual(expect.arrayContaining(["https://example.edu/a", "https://example.edu/fail", "https://example.edu/evidence"]));
    expect(result.evidence).toHaveLength(2);
    expect(result.sources).toHaveLength(2);
    expect(result.toolRun.output).toMatchObject({
      fetchedPages: 2,
      failedUrls: ["https://example.edu/fail"],
      failureReasons: { "https://example.edu/fail": "fetch failed for https://example.edu/fail: 500 Nope" },
      duplicateUrls: ["https://example.edu/a"],
      skippedUrls: []
    });
  });

  it("links WebFetch evidence to the primary web source even when an arXiv PDF candidate is inserted", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      sources: [webSource("arxiv", "https://arxiv.org/abs/2401.00001"), webSource("second", "https://example.edu/second")]
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => successResponse(url))
    );

    const result = await new WebFetchTool().run(input, settings);
    const secondSource = result.sources.find((source) => source.url === "https://example.edu/second");
    const pdfCandidate = result.sources.find((source) => source.url === "https://arxiv.org/pdf/2401.00001");
    const secondEvidence = result.evidence.find((evidence) => evidence.sourceUri === "https://example.edu/second");

    expect(result.sources).toHaveLength(3);
    expect(pdfCandidate).toMatchObject({ kind: "paper" });
    expect(secondEvidence?.sourceId).toBe(secondSource?.id);
    expect(secondEvidence?.sourceId).not.toBe(pdfCandidate?.id);
  });
  it("fetches from ResearchPlan.fetchCandidateUrls before source and citation candidates", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      researchPlan: {
        ...runInput(["WebFetchTool"]).researchPlan!,
        fetchCandidateUrls: ["https://example.edu/from-plan"]
      },
      sources: [webSource("s1", "https://example.edu/from-source")],
      evidence: [
        {
          id: "e1",
          projectId: "project-1",
          category: "web_source" as const,
          title: "Citation URL",
          summary: "Summary",
          citation: "See https://example.edu/from-citation",
          keywords: [],
          linkedHypothesisIds: [],
          createdAt
        }
      ]
    };
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url,
          headers: new Headers({ "content-type": "text/html" }),
          text: async () => `<html><title>${url}</title><body>Readable text for ${url}</body></html>`
        };
      })
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect((result.toolRun.output as { urls: string[] }).urls[0]).toBe("https://example.edu/from-plan");
    expect(fetched).toContain("https://example.edu/from-source");
    expect(fetched).toContain("https://example.edu/from-citation");
  });

  it("refetches engineering program source URLs even when stale fetched sources exist", async () => {
    const clarkYUrl = "https://93.184.216.34/clarky.dat";
    const input = {
      ...runInput(["WebFetchTool"]),
      sources: [
        {
          ...webSource("stale-clark-y", clarkYUrl),
          metadata: { fetchStatus: "fetched", rawText: "CLARK Y AIRFOIL 61.0 61.0 0.0000000 0.0000000" }
        }
      ]
    };
    input.researchPlan = {
      ...input.researchPlan!,
      programRequests: [{ kind: "xfoil-wasm-polar", target: "xfoil-wasm", sourceUrl: clarkYUrl }]
    };
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url,
          headers: new Headers(),
          body: undefined,
          arrayBuffer: async () => new TextEncoder().encode(CLARK_Y_COORDINATES).buffer
        };
      })
    );

    const result = await new WebFetchTool().run(input, settings);
    const rawText = result.sources[0]?.metadata.rawText;

    expect(result.toolRun.status).toBe("completed");
    expect((result.toolRun.output as { urls: string[] }).urls).toEqual([clarkYUrl]);
    expect(fetched).toEqual([clarkYUrl]);
    expect(() => validateAirfoilCoordinateText(String(rawText))).not.toThrow();
  });

  it("retries transient transport failures without changing the selected URL", async () => {
    const url = "https://93.184.216.34/transient";
    const input = { ...runInput(["WebFetchTool"]), sources: [webSource("transient", url)] };
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(successResponse(url));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("completed");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect((result.toolRun.input as { urls: string[] }).urls).toEqual([url]);
  });

  it("fetches up to two URLs concurrently while preserving failure mapping order", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      sources: [webSource("one", "https://93.184.216.34/one"), webSource("two", "https://93.184.216.34/two"), webSource("three", "https://93.184.216.34/three")]
    };
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: Array<{ url: string; resolve: (value: unknown) => void }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        started.push(url);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          pending.push({
            url,
            resolve: (value) => {
              inFlight -= 1;
              resolve(value);
            }
          });
        });
      })
    );

    const running = new WebFetchTool().run(input, settings);
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started).toEqual(["https://93.184.216.34/one", "https://93.184.216.34/two"]);
    pending.find((item) => item.url.endsWith("/one"))?.resolve(successResponse("https://93.184.216.34/one"));
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started).toEqual(["https://93.184.216.34/one", "https://93.184.216.34/two", "https://93.184.216.34/three"]);
    pending.find((item) => item.url.endsWith("/three"))?.resolve(successResponse("https://93.184.216.34/three"));
    pending
      .find((item) => item.url.endsWith("/two"))
      ?.resolve({
        ok: false,
        status: 503,
        statusText: "Slow Fail",
        url: "https://93.184.216.34/two",
        headers: new Headers(),
        text: async () => ""
      });

    const result = await running;

    expect(maxInFlight).toBe(2);
    expect(result.toolRun.status).toBe("completed");
    expect(result.evidence.map((item) => item.sourceUri)).toEqual(["https://93.184.216.34/one", "https://93.184.216.34/three"]);
    expect(result.toolRun.output).toMatchObject({
      failedUrls: ["https://93.184.216.34/two"],
      failureReasons: {
        "https://93.184.216.34/two": "fetch failed for https://93.184.216.34/two: 503 Slow Fail"
      }
    });
  });

  it("blocks internal WebFetch URLs before fetch and records failure reasons", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      sources: [
        webSource("localhost", "http://localhost/admin"),
        webSource("loopback", "http://127.0.0.1/admin"),
        webSource("private", "http://10.1.2.3/admin"),
        webSource("internal", "https://service.internal/status")
      ]
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.sources).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
    expect(result.toolRun.output).toMatchObject({
      fetchedPages: 0,
      failedUrls: ["http://localhost/admin", "http://127.0.0.1/admin", "http://10.1.2.3/admin"],
      skippedUrls: [],
      duplicateUrls: []
    });
    expect((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons["http://localhost/admin"]).toContain(
      "blocked internal hostname"
    );
    expect((result.toolRun.output as { failureReasons: Record<string, string> }).failureReasons["http://127.0.0.1/admin"]).toContain(
      "blocked internal IP address"
    );
  });

  it("rejects unsafe redirects, unsupported content types, and oversized responses", async () => {
    const input = {
      ...runInput(["WebFetchTool"]),
      sources: [
        webSource("redirect", "https://example.edu/redirect"),
        webSource("image", "https://example.edu/image"),
        webSource("large", "https://example.edu/large")
      ]
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(init?.signal).toBeDefined();
        if (url.includes("/redirect")) {
          return {
            ok: false,
            status: 302,
            statusText: "Found",
            url,
            headers: new Headers({ location: "http://127.0.0.1/metadata" })
          };
        }
        if (url.includes("/image")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            url,
            headers: new Headers({ "content-type": "image/png" }),
            text: async () => "not text"
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url,
          headers: new Headers({ "content-type": "text/plain", "content-length": String(2 * 1024 * 1024 + 1) }),
          text: async () => "oversized"
        };
      })
    );

    const result = await new WebFetchTool().run(input, settings);

    expect(result.toolRun.status).toBe("failed");
    expect(result.sources).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
    const output = result.toolRun.output as { failedUrls: string[]; failureReasons: Record<string, string>; fetchedPages: number };
    expect(output.fetchedPages).toBe(0);
    expect(output.failedUrls).toEqual(["https://example.edu/redirect", "https://example.edu/image", "https://example.edu/large"]);
    expect(output.failureReasons["https://example.edu/redirect"]).toContain("blocked internal IP address");
    expect(output.failureReasons["https://example.edu/image"]).toContain("unsupported content-type");
    expect(output.failureReasons["https://example.edu/large"]).toContain("content-length exceeds 2MB");
  });

  it("validates every planned URL before applying the fetch target limit", async () => {
    const input = runInput(["WebFetchTool"]);
    input.researchPlan = {
      ...input.researchPlan!,
      fetchCandidateUrls: ["https://example.edu/one", "https://example.edu/two", "https://example.edu/three", "https://outside.example/four"]
    };
    input.executionContext = {
      toolPolicy: {
        allowOpenCode: false,
        sourceAccess: {
          mode: "allowlist",
          urls: ["https://example.edu/one", "https://example.edu/two", "https://example.edu/three"]
        }
      }
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(new WebFetchTool().run(input, settings)).rejects.toThrow(/outside the job allowlist/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
