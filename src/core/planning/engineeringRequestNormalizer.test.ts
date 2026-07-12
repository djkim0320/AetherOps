import { describe, expect, it } from "vitest";
import type { RuntimeToolDiagnostics } from "../shared/types.js";
import { normalizeProgramRequests, readyProgramRequests } from "./engineeringRequestNormalizer.js";

describe("engineering request normalization", () => {
  it("promotes a validated nested WebXFOIL source URL into the canonical request", () => {
    const requests = normalizeProgramRequests(
      [
        {
          kind: "xfoil-wasm-polar",
          target: "xfoil-wasm",
          cfdRunSpec: {
            target: "xfoil-wasm",
            geometry: { source: "sourceUrl", sourceUrl: "https://example.com/clark-y.dat" },
            flightCondition: { reynolds: 1_000_000, mach: 0, alphaStart: -2, alphaEnd: 2, alphaStep: 2 },
            solver: { name: "webxfoil-wasm", model: "viscous-panel" }
          }
        }
      ],
      []
    );
    const diagnostics = {
      engineeringArtifactCandidates: [],
      engineeringProgramRequestTemplates: [{ id: "xfoil-wasm-polar:xfoil-wasm", ready: true, request: { kind: "xfoil-wasm-polar", target: "xfoil-wasm" } }]
    } as unknown as RuntimeToolDiagnostics;

    expect(readyProgramRequests(requests, diagnostics)[0]).toMatchObject({
      kind: "xfoil-wasm-polar",
      target: "xfoil-wasm",
      sourceUrl: "https://example.com/clark-y.dat"
    });
  });
});
