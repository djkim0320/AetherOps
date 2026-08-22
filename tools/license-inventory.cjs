"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const lockPath = process.argv[2];
if (!lockPath) {
  process.stderr.write("package-lock path is required\n");
  process.exit(2);
}

const bytes = fs.readFileSync(lockPath);
const lock = JSON.parse(bytes.toString("utf8"));
if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
  process.stderr.write("a package-lock v3 packages inventory is required\n");
  process.exit(3);
}

function packageName(packagePath, record) {
  if (typeof record.name === "string" && record.name) return record.name;
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  return index >= 0 ? packagePath.slice(index + marker.length) : packagePath;
}

const production = [];
const development = [];
for (const [packagePath, record] of Object.entries(lock.packages)) {
  if (!packagePath) continue;
  const item = {
    name: packageName(packagePath, record),
    version: String(record.version || ""),
    license: String(record.license || ""),
    integrity: String(record.integrity || ""),
    resolved: String(record.resolved || ""),
    packagePath,
    distributed: !record.dev
  };
  if (!item.name || !item.version || !item.license || !item.integrity || !item.resolved) {
    process.stderr.write(`incomplete package-lock license/source record: ${packagePath}\n`);
    process.exit(4);
  }
  (record.dev ? development : production).push(item);
}

const compare = (left, right) =>
  left.name.localeCompare(right.name) || left.version.localeCompare(right.version) || left.packagePath.localeCompare(right.packagePath);
production.sort(compare);
development.sort(compare);

process.stdout.write(JSON.stringify({
  schema: 1,
  lockfile: path.basename(lockPath),
  lockfileSHA256: crypto.createHash("sha256").update(bytes).digest("hex"),
  production,
  development
}));
