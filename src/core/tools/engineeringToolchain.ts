import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { EngineeringProgramSettings } from "../shared/types.js";

export type EngineeringToolName = "xfoil" | "su2" | "openvsp" | "xflr5";

export interface ResolvedEngineeringToolCommand {
  tool: EngineeringToolName;
  command: string;
  source: "embedded" | "custom";
  root?: string;
}

const DEFAULT_ENGINEERING_TOOLCHAIN_ROOT = "vendor/engineering-tools";
const MAX_SCAN_DEPTH = 6;

const executableNames: Record<EngineeringToolName, string[]> = {
  xfoil: ["xfoil.exe", "xfoil"],
  su2: ["SU2_CFD.exe", "SU2_CFD", "su2_cfd.exe", "su2_cfd"],
  openvsp: ["vspscript.exe", "vspscript", "vsp.exe", "vsp"],
  xflr5: ["xflr5.exe", "XFLR5.exe", "xflr5", "XFLR5"]
};

export function engineeringToolchainRoot(settings: EngineeringProgramSettings): string {
  const configured = settings.toolchainRoot?.trim();
  const envRoot = process.env.AETHEROPS_ENGINEERING_TOOLCHAIN_ROOT?.trim();
  return resolve(configured || envRoot || DEFAULT_ENGINEERING_TOOLCHAIN_ROOT);
}

export function resolveEngineeringToolCommand(
  settings: EngineeringProgramSettings,
  tool: EngineeringToolName,
  configuredCommand: string | undefined
): ResolvedEngineeringToolCommand {
  const explicit = normalizeExplicitCommand(configuredCommand);
  if (explicit) {
    const resolvedExplicit = resolve(explicit);
    if (!isExistingFile(resolvedExplicit)) {
      throw new Error(`Configured ${tool} executable does not exist: ${resolvedExplicit}`);
    }
    return { tool, command: resolvedExplicit, source: "custom" };
  }

  const root = engineeringToolchainRoot(settings);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Embedded engineering toolchain root does not exist: ${root}`);
  }
  const preferredNames = preferredExecutableNames(tool, configuredCommand);
  const match = findExecutableInRoot(root, preferredNames);
  if (!match) {
    throw new Error(`Embedded ${tool} executable not found under ${root}. AetherOps does not use PATH fallback for engineering programs.`);
  }
  return { tool, command: match, source: "embedded", root };
}

export function hasEmbeddedEngineeringTool(settings: EngineeringProgramSettings, tool: EngineeringToolName, configuredCommand: string | undefined): boolean {
  try {
    resolveEngineeringToolCommand(settings, tool, configuredCommand);
    return true;
  } catch {
    return false;
  }
}

export function embeddedEngineeringToolchainStatus(settings: EngineeringProgramSettings): Record<EngineeringToolName, { ready: boolean; command?: string; source?: "embedded" | "custom"; error?: string }> {
  return {
    xfoil: toolStatus(settings, "xfoil", settings.xfoil.command),
    su2: toolStatus(settings, "su2", settings.su2.command),
    openvsp: toolStatus(settings, "openvsp", settings.openVsp.command),
    xflr5: toolStatus(settings, "xflr5", settings.xflr5.command)
  };
}

function toolStatus(settings: EngineeringProgramSettings, tool: EngineeringToolName, command: string | undefined): { ready: boolean; command?: string; source?: "embedded" | "custom"; error?: string } {
  try {
    const resolved = resolveEngineeringToolCommand(settings, tool, command);
    return { ready: true, command: resolved.command, source: resolved.source };
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function preferredExecutableNames(tool: EngineeringToolName, configuredCommand: string | undefined): string[] {
  const bare = configuredCommand?.trim();
  if (!bare || hasPathSeparator(bare)) return executableNames[tool];
  const name = basename(stripQuotes(bare));
  const names = [name];
  if (process.platform === "win32" && !extname(name)) names.push(`${name}.exe`);
  for (const candidate of executableNames[tool]) {
    if (!names.some((item) => item.toLowerCase() === candidate.toLowerCase())) names.push(candidate);
  }
  return names;
}

function findExecutableInRoot(root: string, names: string[]): string | undefined {
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift() as { directory: string; depth: number };
    const entries = safeReadDir(current.directory);
    const filesByName = new Map(entries.filter((entry) => entry.isFile()).map((entry) => [entry.name.toLowerCase(), entry.name]));
    for (const name of names) {
      const fileName = filesByName.get(name.toLowerCase());
      if (fileName) return join(current.directory, fileName);
    }
    for (const entry of entries) {
      const child = join(current.directory, entry.name);
      if (!isInsideRoot(root, child)) continue;
      if (entry.isDirectory() && current.depth < MAX_SCAN_DEPTH) queue.push({ directory: child, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function normalizeExplicitCommand(command: string | undefined): string | undefined {
  const trimmed = stripQuotes(command ?? "");
  if (!trimmed) return undefined;
  if (isAbsolute(trimmed) || hasPathSeparator(trimmed)) return trimmed;
  return undefined;
}

function safeReadDir(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim();
}

function isExistingFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
