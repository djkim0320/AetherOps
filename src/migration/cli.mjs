import { join, resolve } from "node:path";
import { stableStringify } from "./hash.mjs";
import { applyMigration, inspectMigration, rollbackMigration, verifyMigration } from "./commands.mjs";

const DEFAULT_COMMAND = "check";

export async function runMigrationCli(argv = process.argv.slice(2), env = process.env) {
  const options = parseMigrationArgs(argv, env);
  if (options.help) {
    return printHelp();
  }

  const command = options.command ?? DEFAULT_COMMAND;
  const dataRoot = resolve(options.dataRoot ?? env.AETHEROPS_DATA_DIR ?? join(process.cwd(), ".aetherops"));
  const context = { dataRoot, migrationRoot: join(dataRoot, "migration") };

  try {
    if (command === "check") {
      const report = inspectMigration(context, { mutate: false });
      printResult("check", report, options.json);
      return report.exitCode;
    }
    if (command === "apply") {
      const report = applyMigration(context);
      printResult("apply", report, options.json);
      return report.exitCode;
    }
    if (command === "verify") {
      const report = verifyMigration(context);
      printResult("verify", report, options.json);
      return report.exitCode;
    }
    if (command === "rollback") {
      const report = rollbackMigration(context, { allowV2DataLoss: options.allowV2DataLoss });
      printResult("rollback", report, options.json);
      return report.exitCode;
    }
    throw new Error(`Unknown migration command: ${command}`);
  } catch (error) {
    const failure = {
      ok: false,
      command,
      dataRoot,
      error: error instanceof Error ? error.message : String(error)
    };
    printResult(command, failure, options.json, true);
    return 1;
  }
}

export function parseMigrationArgs(argv, env = {}) {
  const options = { command: undefined, dataRoot: undefined, json: false, help: false, allowV2DataLoss: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      options.help = true;
      continue;
    }
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--allow-v2-data-loss") {
      options.allowV2DataLoss = true;
      continue;
    }
    if (value === "--data-root") {
      options.dataRoot = requiredValue(argv, ++index, value);
      continue;
    }
    if (value.startsWith("--data-root=")) {
      const dataRoot = value.slice("--data-root=".length).trim();
      if (!dataRoot) throw new Error("--data-root requires a value.");
      options.dataRoot = dataRoot;
      continue;
    }
    if (!options.command) {
      options.command = value;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.dataRoot && typeof env.AETHEROPS_DATA_DIR === "string" && env.AETHEROPS_DATA_DIR.trim()) {
    options.dataRoot = env.AETHEROPS_DATA_DIR.trim();
  }
  return options;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function printResult(command, payload, jsonMode, isError = false) {
  const stream = isError ? process.stderr : process.stdout;
  if (jsonMode) {
    stream.write(`${stableStringify(payload)}\n`);
    return;
  }
  if (!payload?.ok) {
    stream.write(`AetherOps migration ${command}: FAIL\n`);
    stream.write(`${payload.error ?? "unknown error"}\n`);
    return;
  }
  const lines = [`AetherOps migration ${command}: ${payload.status ?? "ok"}`];
  if (payload.dataRoot) lines.push(`dataRoot: ${payload.dataRoot}`);
  if (payload.migrationRoot) lines.push(`migrationRoot: ${payload.migrationRoot}`);
  if (payload.source?.sourceHash) lines.push(`sourceHash: ${payload.source.sourceHash}`);
  if (payload.current?.targetManifestSha256) lines.push(`manifest: ${payload.current.targetManifestSha256}`);
  if (payload.freeSpaceBytes !== undefined && payload.requiredSpaceBytes !== undefined) {
    lines.push(`freeSpace: ${payload.freeSpaceBytes} / ${payload.requiredSpaceBytes}`);
  }
  if (payload.warnings?.length) {
    lines.push("Warnings:");
    for (const warning of payload.warnings) lines.push(`- ${warning}`);
  }
  stream.write(`${lines.join("\n")}\n`);
}

function printHelp() {
  const lines = [
    "AetherOps migration CLI",
    "Usage: node scripts/migrate.mjs <check|apply|verify|rollback> [--data-root <path>] [--json]",
    "Commands:",
    "  check     Inspect source data and migration readiness.",
    "  apply     Build the v2 migration archive and target SQLite database.",
    "  verify    Validate the applied migration against the recorded manifest.",
    "  rollback  Archive the applied migration target and remove the pointer.",
    "Options:",
    "  --data-root <path>  Override the AetherOps data root.",
    "  --json              Emit machine-readable JSON output.",
    "  --allow-v2-data-loss  Approve rollback when v2 changed after migration.",
    "  --help              Show this help."
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
