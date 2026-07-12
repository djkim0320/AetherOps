import { resolve } from "node:path";

import { AUTONOMY_PROFILES } from "./profiles.mjs";

export function parseAutonomyArgs(rawArgs, cwd = process.cwd()) {
  const parsed = {
    profile: "offline",
    outputRoot: undefined,
    dataRoot: undefined,
    timeoutMs: undefined,
    keepRuntime: false
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];
    if (argument === "--keep-runtime") parsed.keepRuntime = true;
    else if (argument === "--profile") parsed.profile = requiredValue(rawArgs, ++index, argument);
    else if (argument.startsWith("--profile=")) parsed.profile = argument.slice("--profile=".length);
    else if (argument === "--output-root") parsed.outputRoot = resolve(cwd, requiredValue(rawArgs, ++index, argument));
    else if (argument.startsWith("--output-root=")) parsed.outputRoot = resolve(cwd, argument.slice("--output-root=".length));
    else if (argument === "--data-root") parsed.dataRoot = resolve(cwd, requiredValue(rawArgs, ++index, argument));
    else if (argument.startsWith("--data-root=")) parsed.dataRoot = resolve(cwd, argument.slice("--data-root=".length));
    else if (argument === "--timeout-ms") parsed.timeoutMs = positiveInteger(requiredValue(rawArgs, ++index, argument), argument);
    else if (argument.startsWith("--timeout-ms=")) parsed.timeoutMs = positiveInteger(argument.slice("--timeout-ms=".length), "--timeout-ms");
    else throw new Error(`Unknown autonomy verify argument: ${argument}`);
  }
  if (!Object.hasOwn(AUTONOMY_PROFILES, parsed.profile)) {
    throw new Error(`Unknown autonomy profile: ${parsed.profile}`);
  }
  return parsed;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}
