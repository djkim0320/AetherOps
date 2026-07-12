import type { CodexCliRunRequest } from "./codexCliTypes.js";

export const CODEX_WORKSPACE_PERMISSION_PROFILE = "aetherops-workspace";
export const CODEX_READONLY_PERMISSION_PROFILE = "aetherops-readonly";

export function permissionProfileArgs(profile: CodexCliRunRequest["workspaceProfile"], platform: NodeJS.Platform = process.platform): string[] {
  const windows = platform === "win32" ? ["-c", 'windows.sandbox="elevated"'] : [];
  if (profile.mode === "read-only") {
    return [
      "-c",
      `default_permissions="${CODEX_READONLY_PERMISSION_PROFILE}"`,
      "-c",
      `permissions.${CODEX_READONLY_PERMISSION_PROFILE}=${readonlyProfileToml()}`,
      ...windows
    ];
  }
  return [
    "-c",
    `default_permissions="${CODEX_WORKSPACE_PERMISSION_PROFILE}"`,
    "-c",
    `permissions.${CODEX_WORKSPACE_PERMISSION_PROFILE}=${workspaceProfileToml(profile.inputsDirectoryName, profile.outputsDirectoryName)}`,
    ...windows
  ];
}

export function permissionProfileName(profile: CodexCliRunRequest["workspaceProfile"]): string {
  return profile.mode === "read-only" ? CODEX_READONLY_PERMISSION_PROFILE : CODEX_WORKSPACE_PERMISSION_PROFILE;
}

export function workspaceProfileToml(inputsDirectoryName = "inputs", outputsDirectoryName = "outputs"): string {
  return `{description="AetherOps isolated workspace without network access.",filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny",":workspace_roots"={"."="read",${JSON.stringify(inputsDirectoryName)}="read",${JSON.stringify(outputsDirectoryName)}="write",".env"="deny",".env.*"="deny"}},network={enabled=false}}`;
}

function readonlyProfileToml(): string {
  return '{description="AetherOps planner without filesystem writes or network access.",filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny",":workspace_roots"={"."="read"}},network={enabled=false}}';
}
