import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  inspectConfiguredMeshArtifact as inspectConfiguredMeshArtifactImpl,
  inspectMeshArtifact as inspectMeshArtifactImpl,
  resolveInsideRoot as resolveInsideRootImpl
} from "./engineeringProgramMesh.js";
import type { AppSettings } from "../../../core/shared/types.js";

export const inspectMeshArtifact = inspectMeshArtifactImpl;
export const inspectConfiguredMeshArtifact = inspectConfiguredMeshArtifactImpl;
export const resolveInsideRoot = resolveInsideRootImpl;

export function hasConfiguredModelingRoot(settings: AppSettings): boolean {
  if (!settings.engineeringTools.modeling.enabled || !settings.engineeringTools.modeling.artifactRoot?.trim()) return false;
  try {
    const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot);
    return existsSync(artifactRoot) && statSync(artifactRoot).isDirectory();
  } catch {
    return false;
  }
}

export function resolveConfiguredModelingRoot(settings: AppSettings): string {
  if (!settings.engineeringTools.modeling.enabled || !settings.engineeringTools.modeling.artifactRoot?.trim()) {
    throw new Error("Modeling artifact root is not configured.");
  }
  const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot);
  if (!existsSync(artifactRoot) || !statSync(artifactRoot).isDirectory()) {
    throw new Error(`Configured modeling artifact root does not exist: ${artifactRoot}`);
  }
  return artifactRoot;
}
