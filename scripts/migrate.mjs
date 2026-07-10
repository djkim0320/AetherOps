import { runMigrationCli } from "../src/migration/cli.mjs";

process.exitCode = await runMigrationCli(process.argv.slice(2));
