import { parseAutonomyArgs } from "./autonomy/args.mjs";
import { runAutonomyVerification } from "./autonomy/runner.mjs";

const result = await runAutonomyVerification(parseAutonomyArgs(process.argv.slice(2)));
console.log(`AetherOps autonomy verification: ${result.result.verdict}`);
console.log(`Artifacts: ${result.outputRoot}`);
process.exitCode = result.exitCode;
