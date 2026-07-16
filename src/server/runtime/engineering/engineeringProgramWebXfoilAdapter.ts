import { excerpt, boundedNumber, boundedPositiveNumber, requestWithCfdSpecDefaults, safeOutputFileName } from "./engineeringProgramRequestValidator.js";
import { parseXfoilPolarRows } from "./engineeringProgramXfoilAdapter.js";
import { createWebXfoilGeometryReceipt, resolveWasmAirfoilInput } from "./engineeringProgramCoordinateResolver.js";
import type { AirfoilCoordinateResolutionPorts } from "../../../core/tools/engineeringProgramTypes.js";
import type { AppSettings, EngineeringProgramRequest, ResearchToolInput } from "../../../core/shared/types.js";
import { normalizeNacaSeries } from "../../../core/tools/airfoilIdentity.js";
import type { XfoilWasmPolarSummary } from "../../../core/tools/engineeringProgramTypes.js";
import { assertValidWebXfoilResult } from "./webXfoilResultValidation.js";
import { BUNDLED_WEBXFOIL_RUNTIME, BUNDLED_WEBXFOIL_VERSION } from "./engineeringRuntimeVersions.js";
import { createWebXfoilPolarResultReceipt } from "./webXfoilPolarResultReceipt.js";

export function hasConfiguredXfoilWasm(settings: AppSettings): boolean {
  return settings.allowCodeExecution;
}

export async function runXfoilWasmPolar(
  request: EngineeringProgramRequest,
  settings: AppSettings,
  input: ResearchToolInput,
  signal?: AbortSignal,
  ports: Partial<AirfoilCoordinateResolutionPorts> = {}
): Promise<XfoilWasmPolarSummary> {
  signal?.throwIfAborted();
  if (!hasConfiguredXfoilWasm(settings)) {
    throw new Error("XFOIL WebAssembly polar execution requires Engineering capability to be enabled.");
  }
  const executionRequest = requestWithCfdSpecDefaults(request, "xfoil-wasm", settings);
  const coordinateInput = await resolveWasmAirfoilInput(executionRequest, settings, input, ports);
  const reynolds = boundedPositiveNumber(executionRequest.reynolds, 1_000, 100_000_000, 1_000_000, "reynolds");
  const mach = boundedPositiveNumber(executionRequest.mach, 0, 0.8, 0, "mach");
  const alphaStart = boundedNumber(executionRequest.alphaStart, -30, 30, -4, "alphaStart");
  const alphaEnd = boundedNumber(executionRequest.alphaEnd, -30, 30, 12, "alphaEnd");
  const alphaStep = boundedPositiveNumber(executionRequest.alphaStep, 0.1, 10, 2, "alphaStep");
  const transition = executionRequest.transition ?? { mode: "free" as const };
  if (alphaEnd < alphaStart) {
    throw new Error("XFOIL WebAssembly polar request requires alphaEnd >= alphaStart.");
  }

  const { WebXFOIL } = await import("webxfoil-wasm");
  const xfoil = await WebXFOIL.load();
  try {
    signal?.throwIfAborted();
    const session = WebXFOIL.input();
    let airfoil = coordinateInput.label;
    let coordinateFormat: string | undefined;
    if (coordinateInput.text) {
      const loaded = session.loadAirfoilText(coordinateInput.text, {
        path: `${safeOutputFileName(coordinateInput.label, "airfoil")}.dat`,
        name: coordinateInput.label
      });
      airfoil = loaded.name || coordinateInput.label;
      coordinateFormat = loaded.format;
    } else {
      const naca = request.naca?.trim();
      if (!naca) throw new Error("XFOIL WebAssembly NACA request must be a 4 or 5 digit series code.");
      const series = normalizeNacaSeries(naca);
      session.naca(series);
      airfoil = `NACA ${series}`;
    }

    const geometryPath = "/work/aetherops-paneled-airfoil.dat";
    const polarPath = "xfoil-wasm-polar.txt";
    session.add("PANE").add(`SAVE ${geometryPath}`).oper().add("ITER 160").add(`VISC ${reynolds}`).add(`MACH ${mach}`);
    if (transition.mode === "forced") {
      session.add("VPAR").add(`XTR ${transition.upperXOverC} ${transition.lowerXOverC}`).blank();
    }
    session.add("PACC").add(polarPath).blank().add(`ASEQ ${alphaStart} ${alphaEnd} ${alphaStep}`).add("PACC").blank().quit();

    signal?.throwIfAborted();
    const result = xfoil.run(session.toString(), { workDir: "/work", files: session.files, scalarKeys: ["CL", "CD", "Cm", "a"] });
    signal?.throwIfAborted();
    const geometryReceipt = createWebXfoilGeometryReceipt(String(xfoil.readFile(geometryPath, "utf8")));
    const polarText = String(xfoil.readFile(`/work/${polarPath}`, "utf8"));
    const rows = parseXfoilPolarRows(polarText);
    if (!rows.length) {
      throw new Error(`XFOIL WebAssembly produced no polar rows. stdout=${excerpt(result.raw.stdout)} stderr=${excerpt(result.raw.stderr)}`);
    }
    const convergence = {
      hasNaN: Boolean(result.output.hasNaN),
      hasFortranError: Boolean(result.output.hasFortranError),
      hasConvergenceFail: Boolean(result.output.hasConvergenceFail)
    };
    assertValidWebXfoilResult({ alphaStart, alphaEnd, alphaStep, rows, convergence });
    const transitionLocations =
      transition.mode === "forced"
        ? {
            upperXOverC: transition.upperXOverC,
            lowerXOverC: transition.lowerXOverC,
            sourceEvidenceId: transition.sourceEvidenceId
          }
        : undefined;
    const polarResultReceipt = createWebXfoilPolarResultReceipt({
      runtimeVersion: BUNDLED_WEBXFOIL_VERSION,
      geometry: geometryReceipt,
      request: {
        reynolds,
        mach,
        alphaStart,
        alphaEnd,
        alphaStep,
        transition: transition.mode,
        ...(transitionLocations ? { transitionLocations } : {})
      },
      rows,
      convergence
    });
    return {
      airfoil,
      runtime: BUNDLED_WEBXFOIL_RUNTIME,
      runtimeVersion: BUNDLED_WEBXFOIL_VERSION,
      runtimeLicense: "GPL-2.0-or-later",
      geometryContentHash: geometryReceipt.contentHash,
      geometryPointCount: geometryReceipt.pointCount,
      geometryReceiptVersion: geometryReceipt.version,
      polarResultHash: polarResultReceipt.contentHash,
      polarResultReceiptVersion: polarResultReceipt.version,
      sourceKind: coordinateInput.sourceKind,
      sourceLabel: coordinateInput.label,
      sourceUrl: coordinateInput.sourceUrl,
      sourceArtifactPath: coordinateInput.sourceArtifactPath,
      coordinateFormat,
      reynolds,
      mach,
      alphaStart,
      alphaEnd,
      alphaStep,
      transition: transition.mode,
      ...(transitionLocations ? { transitionLocations } : {}),
      rowCount: rows.length,
      rows,
      stdoutExcerpt: excerpt(result.raw.stdout),
      stderrExcerpt: excerpt(result.raw.stderr),
      convergence
    };
  } finally {
    xfoil.destroy();
  }
}
