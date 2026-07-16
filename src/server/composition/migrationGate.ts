import { execFile } from "node:child_process";
import { join } from "node:path";

export async function runRequiredMigration(appRoot: string, dataRoot: string): Promise<void> {
  const script = join(appRoot, "scripts", "migrate.mjs");
  await run(process.execPath, [script, "apply", "--data-root", dataRoot, "--json"]);
  await run(process.execPath, [script, "verify", "--data-root", dataRoot, "--json"]);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      reject(new Error(`Required storage migration failed: ${stdout.trim() || stderr.trim() || error.message}`, { cause: error }));
    });
  });
}
