import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
rmSync(join(root, "dist-electron"), { recursive: true, force: true });
rmSync(join(root, "tsconfig.electron.tsbuildinfo"), { force: true });
