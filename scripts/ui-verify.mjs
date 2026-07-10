import { runUiLayoutVerification } from "./ui-verify/runner.mjs";

const { exitCode } = await runUiLayoutVerification(process.argv.slice(2));
process.exitCode = exitCode;
