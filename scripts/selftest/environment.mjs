import { command } from "./runtime.mjs";
import { satisfiesNodeEngine } from "../lib/checks.mjs";
import { describeStaticMode } from "./static.mjs";

export function collectEnvironment(context) {
  context.results.environment = {
    nodeVersion: process.version,
    npmVersion: command(context.npm, ["-v"]).stdout.trim(),
    os: `${process.platform} ${process.arch}`,
    engine: context.packageJson.engines?.node ?? "unspecified",
    engineSatisfied: satisfiesNodeEngine(process.versions.node, context.packageJson.engines?.node ?? ">=22.16.0"),
    scripts: Object.keys(context.packageJson.scripts ?? {}),
    staticMode: describeStaticMode(context),
    dataRoot: context.dataRoot
  };
  if (!context.results.environment.engineSatisfied) {
    context.results.findings.critical.push(`Node engine check failed: ${process.version} does not satisfy ${context.results.environment.engine}.`);
  }
}
