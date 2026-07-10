import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { AppSettings, EngineeringProgramRequest, OpenCodeRunInput } from "../../../core/shared/types.js";
import type { AirfoilCoordinateInput, AirfoilCoordinateResolutionPorts } from "../../../core/tools/engineeringProgramTypes.js";
import { createDefaultPublicUrlPolicy } from "./publicUrlPolicy.js";
import { BoundedHttpClient } from "../tools/boundedHttpClient.js";
import { resolveConfiguredModelingRoot, resolveInsideRoot } from "./engineeringProgramMeshAdapter.js";

export async function resolveWasmAirfoilInput(
  request: EngineeringProgramRequest,
  settings: AppSettings,
  input: OpenCodeRunInput,
  ports: Partial<AirfoilCoordinateResolutionPorts> = {}
): Promise<AirfoilCoordinateInput> {
  if (request.artifactPath?.trim()) {
    const artifactRoot = resolveConfiguredModelingRoot(settings);
    const targetPath = resolveInsideRoot(artifactRoot, request.artifactPath.trim());
    if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
      throw new Error(`XFOIL WebAssembly airfoil coordinate file does not exist under configured root: ${request.artifactPath}`);
    }
    const stats = statSync(targetPath);
    if (stats.size > settings.engineeringTools.modeling.maxMeshBytes) {
      throw new Error(`XFOIL WebAssembly airfoil coordinate file exceeds maxMeshBytes (${stats.size} > ${settings.engineeringTools.modeling.maxMeshBytes}).`);
    }
    const text = readFileSync(targetPath, "utf8");
    validateAirfoilCoordinateText(text);
    return {
      text,
      label: basename(targetPath, extname(targetPath)),
      sourceKind: "artifact",
      sourceArtifactPath: request.artifactPath.trim()
    };
  }

  const sourceUrl = request.sourceUrl?.trim();
  if (sourceUrl) {
    const fetchedSource = findFetchedAirfoilSource(input, sourceUrl);
    if (fetchedSource) return fetchedSource;
    if (!input.project.autonomyPolicy.allowExternalSearch || !settings.allowExternalSearch) {
      throw new Error(
        "XFOIL WebAssembly sourceUrl execution requires WebFetchTool-provided rawText or external search permission for direct coordinate fetch."
      );
    }
    const text = await fetchAirfoilCoordinateText(
      sourceUrl,
      settings.engineeringTools.xfoil.timeoutMs,
      ports.publicUrlPolicy ?? createDefaultPublicUrlPolicy()
    );
    validateAirfoilCoordinateText(text);
    return {
      text,
      label: airfoilLabelFromUrl(sourceUrl),
      sourceKind: "direct-url",
      sourceUrl
    };
  }

  const discoveredSource = findFetchedAirfoilSource(input);
  if (discoveredSource) return discoveredSource;

  const naca = request.naca?.trim();
  if (naca) {
    if (!/^\d{4,5}$/.test(naca)) {
      throw new Error("XFOIL WebAssembly NACA request must be a 4 or 5 digit series code.");
    }
    return {
      label: `NACA ${naca}`,
      sourceKind: "naca"
    };
  }

  throw new Error("XFOIL WebAssembly polar execution requires naca, artifactPath, sourceUrl, or a fetched airfoil coordinate source.");
}

export function validateAirfoilCoordinateText(text: string): { pointCount: number; xMin: number; xMax: number; yMin: number; yMax: number } {
  const points: Array<{ x: number; y: number }> = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/[\s,]+/);
    if (parts.length < 2) continue;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs(x) > 2 || Math.abs(y) > 2) continue;
    points.push({ x, y });
  }
  if (points.length < 10) {
    throw new Error(`Airfoil coordinate file must contain at least 10 finite coordinate pairs; found ${points.length}.`);
  }
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  if (xMax - xMin < 0.01) {
    throw new Error("Airfoil coordinate file does not span a usable chord length.");
  }
  if (yMax - yMin <= 0) {
    throw new Error("Airfoil coordinate file does not contain a usable thickness/camber range.");
  }
  return { pointCount: points.length, xMin, xMax, yMin, yMax };
}

async function fetchAirfoilCoordinateText(
  sourceUrl: string,
  timeoutMs: number,
  publicUrlPolicy: AirfoilCoordinateResolutionPorts["publicUrlPolicy"]
): Promise<string> {
  const effectiveTimeoutMs = clampAirfoilFetchTimeout(timeoutMs);
  const client = new BoundedHttpClient({
    timeoutMs: effectiveTimeoutMs,
    maxBytes: 2 * 1024 * 1024,
    publicUrlPolicy: {
      async assertPublicHttpUrl(value: string): Promise<string> {
        await publicUrlPolicy.assertPublicUrl(value);
        return value;
      }
    }
  });
  const response = await client.request(sourceUrl, {}, { accept: "text/plain,text/*,*/*" });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`airfoil coordinate fetch failed for ${sourceUrl}: ${response.status} ${response.statusText}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
}

function findFetchedAirfoilSource(input: OpenCodeRunInput, sourceUrl?: string): AirfoilCoordinateInput | undefined {
  const requestedUrl = sourceUrl ? normalizeUrlForCompare(sourceUrl) : undefined;
  let invalidRequestedSource: string | undefined;
  const sources = input.sources ?? [];
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const source = sources[index];
    if (!source) continue;
    const url = typeof source.url === "string" ? source.url : "";
    if (requestedUrl && normalizeUrlForCompare(url) !== requestedUrl) continue;
    const rawText = source.metadata && typeof source.metadata.rawText === "string" ? source.metadata.rawText : "";
    if (!rawText) continue;
    try {
      validateAirfoilCoordinateText(rawText);
      return {
        text: rawText,
        label: source.title || airfoilLabelFromUrl(url),
        sourceKind: "source",
        sourceUrl: url
      };
    } catch (error) {
      if (requestedUrl) invalidRequestedSource = error instanceof Error ? error.message : String(error);
    }
  }
  if (requestedUrl && invalidRequestedSource) {
    throw new Error(`Fetched source does not contain a valid airfoil coordinate file: ${sourceUrl} (${invalidRequestedSource})`);
  }
  return undefined;
}

function clampAirfoilFetchTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return 30_000;
  return Math.min(120_000, Math.max(10_000, Math.trunc(timeoutMs)));
}

function normalizeUrlForCompare(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

function airfoilLabelFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const file = basename(parsed.pathname) || parsed.hostname;
    return file.replace(/\.[A-Za-z0-9]+$/, "") || "airfoil";
  } catch {
    return "airfoil";
  }
}
