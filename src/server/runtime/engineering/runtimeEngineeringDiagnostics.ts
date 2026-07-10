import { readdirSync, readFileSync, statSync, type Dirent, type Stats } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { AppSettings, EngineeringArtifactCandidate, RuntimeToolDiagnostics } from "../../../core/shared/types.js";
import { buildRuntimeToolDiagnostics } from "../../../core/tools/runtimeToolDiagnostics.js";
import { validateAirfoilCoordinateText } from "./engineeringProgramCoordinateResolver.js";
import { inspectConfiguredMeshArtifact } from "./engineeringProgramMesh.js";

const MAX_SCAN_DEPTH = 3;
const MAX_CANDIDATES = 128;

interface ArtifactScan {
  candidates: EngineeringArtifactCandidate[];
  blockedReason?: string;
}

export function buildServerRuntimeToolDiagnostics(settings: AppSettings): RuntimeToolDiagnostics {
  return buildRuntimeToolDiagnostics(settings, scanEngineeringArtifactCandidates(settings));
}

export function scanEngineeringArtifactCandidates(settings: AppSettings): ArtifactScan {
  if (!settings.allowCodeExecution || !settings.engineeringTools.enabled || !settings.engineeringTools.modeling.enabled) {
    return { candidates: [] };
  }
  const configuredRoot = settings.engineeringTools.modeling.artifactRoot?.trim();
  if (!configuredRoot) return { candidates: [], blockedReason: "Modeling artifact root is not configured." };
  const root = resolve(configuredRoot);
  const rootStats = safeStat(root);
  if (!rootStats) return { candidates: [], blockedReason: `Configured modeling artifact root does not exist: ${root}` };
  if (!rootStats.isDirectory()) return { candidates: [], blockedReason: `Configured modeling artifact root is not a directory: ${root}` };

  const candidates: EngineeringArtifactCandidate[] = [];
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length && candidates.length < MAX_CANDIDATES) {
    const current = queue.shift();
    if (!current) break;
    for (const entry of safeEntries(current.directory)) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (entry.isSymbolicLink()) continue;
      const childPath = resolve(current.directory, entry.name);
      if (!isInsideRoot(root, childPath)) continue;
      if (entry.isDirectory()) {
        if (current.depth < MAX_SCAN_DEPTH) queue.push({ directory: childPath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const format = formatFromExtension(extname(entry.name).toLowerCase());
      if (!format) continue;
      const stats = safeStat(childPath);
      if (!stats?.isFile()) continue;
      const relativePath = relative(root, childPath).replace(/\\/g, "/");
      candidates.push({
        relativePath,
        fileName: entry.name,
        format,
        byteLength: stats.size,
        ...validateCandidate(settings, childPath, relativePath, stats.size, format)
      });
    }
  }
  candidates.sort((left, right) => Number(right.ready) - Number(left.ready) || left.relativePath.localeCompare(right.relativePath));
  if (!candidates.length) {
    return { candidates, blockedReason: `No OBJ/STL/VSP3 or airfoil coordinate artifacts were found under the configured modeling artifact root: ${root}` };
  }
  if (!candidates.some((candidate) => candidate.ready)) {
    return { candidates, blockedReason: "No parser-valid engineering artifact is available under the configured modeling root within maxMeshBytes." };
  }
  return { candidates };
}

function validateCandidate(
  settings: AppSettings,
  absolutePath: string,
  relativePath: string,
  byteLength: number,
  format: EngineeringArtifactCandidate["format"]
): Pick<EngineeringArtifactCandidate, "ready" | "validated" | "blockedReason"> {
  const maxBytes = settings.engineeringTools.modeling.maxMeshBytes;
  if (byteLength > maxBytes) return { ready: false, validated: false, blockedReason: `exceeds maxMeshBytes (${byteLength} > ${maxBytes})` };
  try {
    if (format === "airfoil-coordinate") validateAirfoilCoordinateText(readFileSync(absolutePath, "utf8"));
    else if (format === "vsp3") {
      if (byteLength === 0) throw new Error("OpenVSP artifact is empty.");
    } else inspectConfiguredMeshArtifact(settings, relativePath);
    return { ready: true, validated: true };
  } catch (error) {
    return { ready: false, validated: false, blockedReason: `${format} validation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function safeStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function safeEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return Boolean(path) && !path.startsWith("..") && !isAbsolute(path);
}

function formatFromExtension(extension: string): EngineeringArtifactCandidate["format"] | undefined {
  if (extension === ".obj") return "obj";
  if (extension === ".stl") return "stl";
  if (extension === ".vsp3") return "vsp3";
  if (extension === ".dat" || extension === ".txt") return "airfoil-coordinate";
  return undefined;
}
