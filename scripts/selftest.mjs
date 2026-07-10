import { runSelfTest } from "./selftest/process.mjs";

const { exitCode } = await runSelfTest(process.argv.slice(2));
process.exit(exitCode);
