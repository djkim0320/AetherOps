import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const COMMANDS = new Set(["verify", "eval"]);

export function parseHarnessArgs(rawArgs, repoRoot) {
  const [command, ...flags] = rawArgs;
  if (!COMMANDS.has(command)) throw new Error("Harness command must be either verify or eval.");
  let outputRoot;
  for (let index = 0; index < flags.length; index += 1) {
    const argument = flags[index];
    if (argument === "--output-root") outputRoot = resolve(repoRoot, requiredValue(flags, ++index, argument));
    else if (argument.startsWith("--output-root=")) outputRoot = resolve(repoRoot, argument.slice("--output-root=".length));
    else throw new Error(`Unknown harness argument: ${argument}`);
  }

  const allowedRoot = resolve(repoRoot, ".tmp", "harness");
  const resolvedOutput = outputRoot ?? join(allowedRoot, `${command}-${timestamp()}-${process.pid}`);
  const relativePath = relative(allowedRoot, resolvedOutput);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${separator()}`)) {
    throw new Error("Harness output root must be a new child of .tmp/harness.");
  }
  if (existsSync(resolvedOutput)) throw new Error(`Harness output root already exists: ${relativePath.replace(/\\/g, "/")}`);
  return { command, outputRoot: resolvedOutput };
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function separator() {
  return process.platform === "win32" ? "\\" : "/";
}
