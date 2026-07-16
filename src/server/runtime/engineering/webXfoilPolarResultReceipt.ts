import { createHash } from "node:crypto";
import type { XfoilPolarRow } from "../../../core/tools/engineeringProgramTypes.js";
import type { WebXfoilGeometryReceipt } from "./engineeringProgramCoordinateResolver.js";

export const WEBXFOIL_POLAR_RESULT_RECEIPT_VERSION = "webxfoil-polar-result-v1" as const;

export interface WebXfoilPolarResultReceiptInput {
  runtimeVersion: string;
  geometry: WebXfoilGeometryReceipt;
  request: {
    reynolds: number;
    mach: number;
    alphaStart: number;
    alphaEnd: number;
    alphaStep: number;
    transition: "free" | "forced";
    transitionLocations?: { upperXOverC: number; lowerXOverC: number; sourceEvidenceId: string };
  };
  rows: readonly XfoilPolarRow[];
  convergence: {
    hasNaN: boolean;
    hasFortranError: boolean;
    hasConvergenceFail: boolean;
  };
}

export function createWebXfoilPolarResultReceipt(input: WebXfoilPolarResultReceiptInput): {
  contentHash: string;
  version: typeof WEBXFOIL_POLAR_RESULT_RECEIPT_VERSION;
} {
  const canonical = canonicalJson({
    version: WEBXFOIL_POLAR_RESULT_RECEIPT_VERSION,
    runtime: "webxfoil-wasm",
    runtimeVersion: input.runtimeVersion,
    geometry: {
      contentHash: input.geometry.contentHash,
      pointCount: input.geometry.pointCount,
      receiptVersion: input.geometry.version
    },
    request: input.request,
    rows: input.rows,
    convergence: input.convergence
  });
  return {
    contentHash: createHash("sha256").update(canonical, "utf8").digest("hex"),
    version: WEBXFOIL_POLAR_RESULT_RECEIPT_VERSION
  };
}

function canonicalJson(value: unknown): string {
  if (value === undefined || value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
