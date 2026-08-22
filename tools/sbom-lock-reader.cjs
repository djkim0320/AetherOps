"use strict";

const fs = require("node:fs");

const lockPath = process.argv[2];
if (!lockPath) {
  process.stderr.write("package-lock path is required\n");
  process.exit(2);
}
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const entry = lock.packages && lock.packages["node_modules/oxigraph"];
if (!entry) {
  process.stderr.write("Oxigraph package-lock entry is missing\n");
  process.exit(3);
}
process.stdout.write(JSON.stringify(entry));
