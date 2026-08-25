"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[2] || "");
const output = path.resolve(process.argv[3] || "");
if (!root || !output) {
  process.stderr.write("repository root and output directory are required\n");
  process.exit(2);
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function npmName(packagePath, record) {
  if (typeof record.name === "string" && record.name) return record.name;
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  return index >= 0 ? packagePath.slice(index + marker.length) : packagePath;
}

function npmPurl(name, version) {
  return `pkg:npm/${name.replaceAll("@", "%40")}@${version}`;
}

function spdxID(purl) {
  const safe = purl.replace(/[^A-Za-z0-9.-]/g, "-");
  const suffix = crypto.createHash("sha256").update(purl).digest("hex").slice(0, 12);
  return `SPDXRef-${safe}-${suffix}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const manifest = readJSON(path.join(root, "sbom", "license-manifest.json"));
const frontendLock = readJSON(path.join(root, "frontend", "package-lock.json"));
if (manifest.schema !== 1 || manifest.product !== "AetherOps" || !Array.isArray(manifest.production)) {
  throw new Error("invalid reviewed license manifest");
}
if (frontendLock.lockfileVersion !== 3 || typeof frontendLock.packages !== "object") {
  throw new Error("frontend package-lock v3 inventory is required");
}

const production = manifest.production.map((component) => {
  const license = String(component.license_expression || "").trim();
  if (component.distributed !== true || !license || license === "NOASSERTION" || license === "NONE") {
    throw new Error(`unreviewed production license: ${component.id}`);
  }
  if (!Array.isArray(component.source_receipts) || component.source_receipts.length === 0) {
    throw new Error(`missing production source receipt: ${component.id}`);
  }
  if (!Array.isArray(component.license_payloads) || component.license_payloads.length === 0) {
    throw new Error(`missing production license payload: ${component.id}`);
  }
  return component;
});

const developmentByPurl = new Map();
for (const [packagePath, record] of Object.entries(frontendLock.packages)) {
  if (!packagePath || !record.dev) continue;
  const name = npmName(packagePath, record);
  const version = String(record.version || "");
  const license = String(record.license || "").trim();
  const integrity = String(record.integrity || "");
  const resolved = String(record.resolved || "");
  if (!name || !version || !license || license === "NOASSERTION" || license === "NONE" || !integrity || !resolved) {
    throw new Error(`incomplete development license/source record: ${packagePath}`);
  }
  const purl = npmPurl(name, version);
  const current = developmentByPurl.get(purl);
  if (current && (current.license !== license || current.integrity !== integrity || current.resolved !== resolved)) {
    throw new Error(`conflicting development package receipts: ${purl}`);
  }
  developmentByPurl.set(purl, { name, version, license, integrity, resolved, purl });
}
const development = [...developmentByPurl.values()].sort((left, right) => compareText(left.purl, right.purl));

function cycloneComponent(component) {
  const sourceReceipts = component.source_receipts.map((receipt) => ({
    type: "distribution",
    url: String(receipt.url)
  }));
  const properties = [
    { name: "aetherops:dependency-kind", value: String(component.dependency_kind) },
    { name: "aetherops:distributed", value: "true" },
    ...component.source_receipts.map((receipt) => ({
      name: "aetherops:source-receipt",
      value: `${receipt.algorithm}:${receipt.value}`
    })),
    ...component.license_payloads.map((payload) => ({
      name: "aetherops:license-payload",
      value: `${payload.path}:sha256:${payload.sha256}`
    }))
  ];
  const entry = {
    type: ["direct", "transitive", "frontend-production"].includes(component.dependency_kind) ? "library" : "application",
    name: String(component.name),
    version: String(component.version),
    purl: String(component.purl),
    scope: "required",
    licenses: [{ expression: String(component.license_expression) }],
    externalReferences: sourceReceipts,
    properties
  };
  const hashes = component.source_receipts
    .filter((receipt) => receipt.algorithm === "SHA-256")
    .map((receipt) => ({ alg: "SHA-256", content: String(receipt.value) }));
  if (hashes.length) entry.hashes = hashes;
  return entry;
}

const cycloneComponents = production.map(cycloneComponent);
for (const item of development) {
  cycloneComponents.push({
    type: "library",
    name: item.name,
    version: item.version,
    purl: item.purl,
    scope: "excluded",
    licenses: [{ expression: item.license }],
    externalReferences: [{ type: "distribution", url: item.resolved }],
    properties: [
      { name: "aetherops:dependency-kind", value: "frontend-build-dev" },
      { name: "aetherops:distributed", value: "false" },
      { name: "aetherops:npm-integrity", value: item.integrity }
    ]
  });
}

const developmentProperties = manifest.development_sets.map((set) => ({
  name: `aetherops:development-set:${set.id}`,
  value: `distributed=false;count=${set.package_count ?? "not-applicable"}`
}));
const cyclone = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: "urn:uuid:863d6912-f3b9-4a72-a6ed-fb2b43429191",
  version: 1,
  metadata: {
    component: {
      type: "application",
      name: "AetherOps",
      version: String(manifest.version),
      purl: `pkg:github/djkim0320/Aether-claw@v${manifest.version}`
    },
    properties: developmentProperties
  },
  components: cycloneComponents
};

const rootID = "SPDXRef-AetherOps";
const packages = [{
  name: "AetherOps",
  SPDXID: rootID,
  versionInfo: String(manifest.version),
  downloadLocation: "NOASSERTION",
  filesAnalyzed: false,
  licenseConcluded: "NONE",
  licenseDeclared: "NONE",
  externalRefs: [{
    referenceCategory: "PACKAGE-MANAGER",
    referenceType: "purl",
    referenceLocator: `pkg:github/djkim0320/Aether-claw@v${manifest.version}`
  }]
}];
const relationships = [];
for (const component of production) {
  const id = spdxID(component.purl);
  const pkg = {
    name: String(component.name),
    SPDXID: id,
    versionInfo: String(component.version),
    downloadLocation: String(component.source_receipts[0].url),
    filesAnalyzed: false,
    licenseConcluded: String(component.license_expression),
    licenseDeclared: String(component.license_expression),
    licenseComments: component.license_payloads
      .map((payload) => `${payload.path}:sha256:${payload.sha256}`)
      .join("; "),
    externalRefs: [{
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: String(component.purl)
    }]
  };
  const checksums = component.source_receipts
    .filter((receipt) => receipt.algorithm === "SHA-256")
    .map((receipt) => ({ algorithm: "SHA256", checksumValue: String(receipt.value) }));
  if (checksums.length) pkg.checksums = checksums;
  packages.push(pkg);
  relationships.push({ spdxElementId: rootID, relationshipType: "DEPENDS_ON", relatedSpdxElement: id });
}
for (const item of development) {
  const id = spdxID(item.purl);
  packages.push({
    name: item.name,
    SPDXID: id,
    versionInfo: item.version,
    downloadLocation: item.resolved,
    filesAnalyzed: false,
    licenseConcluded: item.license,
    licenseDeclared: item.license,
    externalRefs: [{
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: item.purl
    }],
    sourceInfo: `Frontend build/test dependency; distributed=false; npm integrity ${item.integrity}`
  });
  relationships.push({ spdxElementId: id, relationshipType: "DEV_DEPENDENCY_OF", relatedSpdxElement: rootID });
}

const nosaText = fs.readFileSync(
  path.join(root, "sbom", "licenses", "runtime", "openvsp-3.50.4-NOSA-1.3.txt"),
  "utf8"
);
const spdx = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `AetherOps-${manifest.version}`,
  documentNamespace: `https://github.com/djkim0320/AetherOps/sbom/v${manifest.version}`,
  creationInfo: { creators: ["Tool: AetherOps tools/sbom.ps1 + tools/license-sbom.cjs"] },
  packages,
  relationships,
  hasExtractedLicensingInfos: [{
    licenseId: "LicenseRef-NOSA-1.3",
    extractedText: nosaText,
    name: "NASA Open Source Agreement 1.3",
    seeAlsos: ["https://github.com/OpenVSP/OpenVSP/blob/OpenVSP_3.50.4/LICENSE"]
  }]
};

for (const component of cyclone.components.filter((item) => item.scope === "required")) {
  if (!component.licenses.length || !component.licenses[0].expression || component.licenses[0].expression === "NOASSERTION") {
    throw new Error(`release CycloneDX component has no reviewed license: ${component.purl}`);
  }
}
for (const pkg of spdx.packages.filter((item) => item.SPDXID !== rootID)) {
  if (!pkg.licenseDeclared || pkg.licenseDeclared === "NOASSERTION" || !pkg.licenseConcluded || pkg.licenseConcluded === "NOASSERTION") {
    throw new Error(`release SPDX package has no reviewed license: ${pkg.name}`);
  }
}

fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "cyclonedx.json"), JSON.stringify(cyclone, null, 2));
fs.writeFileSync(path.join(output, "spdx.json"), JSON.stringify(spdx, null, 2));
