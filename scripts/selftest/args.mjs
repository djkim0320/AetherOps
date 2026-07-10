export function parseArgs(rawArgs) {
  const parsed = { strictLive: false, skipStatic: false, fullStatic: false };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg || arg === "--") continue;
    if (arg.startsWith("--mode=")) parsed.mode = arg.slice("--mode=".length);
    else if (arg === "--mode") parsed.mode = requiredValue(rawArgs, ++index, arg);
    else if (arg.startsWith("--port=")) parsed.port = Number(arg.slice("--port=".length));
    else if (arg === "--port") parsed.port = Number(requiredValue(rawArgs, ++index, arg));
    else if (arg.startsWith("--data-root=")) parsed.dataRoot = arg.slice("--data-root=".length);
    else if (arg === "--data-root") parsed.dataRoot = requiredValue(rawArgs, ++index, arg);
    else if (arg === "--strict-live") parsed.strictLive = true;
    else if (arg === "--skip-static") parsed.skipStatic = true;
    else if (arg === "--full-static") parsed.fullStatic = true;
    else throw new Error(`Unknown selftest argument: ${arg}`);
  }
  if (!["full", "blocked", "live", undefined].includes(parsed.mode)) {
    throw new Error(`Unknown selftest mode: ${parsed.mode}`);
  }
  return parsed;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}
