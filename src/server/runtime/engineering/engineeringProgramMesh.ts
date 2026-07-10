import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { AppSettings, EngineeringProgramRequest } from "../../../core/shared/types.js";
import type { MeshSummary } from "../../../core/tools/engineeringProgramTypes.js";

export function inspectMeshArtifact(request: EngineeringProgramRequest, settings: AppSettings): MeshSummary {
  if (!settings.engineeringTools.modeling.enabled || !settings.engineeringTools.modeling.artifactRoot?.trim()) {
    throw new Error("Mesh inspection requires a configured modeling artifact root.");
  }
  if (!request.artifactPath?.trim()) {
    throw new Error("Mesh inspection requires programRequests[].artifactPath.");
  }
  const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot);
  if (!existsSync(artifactRoot) || !statSync(artifactRoot).isDirectory()) {
    throw new Error("Mesh inspection requires a configured modeling artifact root.");
  }
  const targetPath = resolveInsideRoot(artifactRoot, request.artifactPath);
  if (!existsSync(targetPath)) {
    throw new Error(`Mesh artifact does not exist under configured root: ${request.artifactPath}`);
  }
  const stats = statSync(targetPath);
  if (!stats.isFile()) {
    throw new Error(`Mesh artifact is not a file: ${request.artifactPath}`);
  }
  const maxBytes = settings.engineeringTools.modeling.maxMeshBytes;
  if (stats.size > maxBytes) {
    throw new Error(`Mesh artifact exceeds maxMeshBytes (${stats.size} > ${maxBytes}).`);
  }
  const buffer = readFileSync(targetPath);
  const extension = extname(targetPath).toLowerCase();
  if (extension === ".obj") return parseObjMesh(buffer, basename(targetPath));
  if (extension === ".stl") return parseStlMesh(buffer, basename(targetPath));
  throw new Error(`Unsupported mesh format for inspection: ${extension || "unknown"}`);
}

export function inspectConfiguredMeshArtifact(settings: AppSettings, artifactPath: string): MeshSummary {
  return inspectMeshArtifact({ kind: "mesh-inspect", target: "modeling", artifactPath }, settings);
}

export function resolveInsideRoot(root: string, artifactPath: string): string {
  const candidate = isAbsolute(artifactPath) ? resolve(artifactPath) : resolve(root, artifactPath);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Configured path escapes the allowed root.");
  }
  return candidate;
}

function parseObjMesh(buffer: Buffer, fileName: string): MeshSummary {
  const bounds = createBounds();
  let vertexCount = 0;
  let faceCount = 0;
  let triangleCount = 0;
  for (const line of buffer.toString("utf8").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "v" && parts.length >= 4) {
      const point = toPoint(parts[1], parts[2], parts[3]);
      if (point) {
        vertexCount += 1;
        updateBounds(bounds, point);
      }
      continue;
    }
    if (parts[0] === "f" && parts.length >= 4) {
      const vertices = parts.length - 1;
      faceCount += 1;
      triangleCount += Math.max(1, vertices - 2);
    }
  }
  if (!vertexCount) throw new Error("OBJ mesh contains no finite vertices.");
  return {
    fileName,
    format: "obj",
    byteLength: buffer.byteLength,
    vertexCount,
    faceCount,
    triangleCount,
    boundingBox: finalizeBounds(bounds)
  };
}

function parseStlMesh(buffer: Buffer, fileName: string): MeshSummary {
  const textStart = buffer.subarray(0, Math.min(buffer.byteLength, 1024)).toString("utf8");
  if (/^\s*solid\b/i.test(textStart) && /\bfacet\s+normal\b/i.test(buffer.toString("utf8", 0, Math.min(buffer.byteLength, 8192)))) {
    return parseAsciiStl(buffer, fileName);
  }
  return parseBinaryStl(buffer, fileName);
}

function parseAsciiStl(buffer: Buffer, fileName: string): MeshSummary {
  const bounds = createBounds();
  let vertexCount = 0;
  for (const line of buffer.toString("utf8").split(/\r?\n/)) {
    const match = line
      .trim()
      .match(/^vertex\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i);
    if (!match) continue;
    const point = toPoint(match[1], match[2], match[3]);
    if (!point) continue;
    vertexCount += 1;
    updateBounds(bounds, point);
  }
  if (!vertexCount || vertexCount % 3 !== 0) throw new Error("ASCII STL mesh has no complete finite triangles.");
  const triangleCount = vertexCount / 3;
  return {
    fileName,
    format: "stl-ascii",
    byteLength: buffer.byteLength,
    vertexCount,
    faceCount: triangleCount,
    triangleCount,
    boundingBox: finalizeBounds(bounds)
  };
}

function parseBinaryStl(buffer: Buffer, fileName: string): MeshSummary {
  if (buffer.byteLength < 84) throw new Error("Binary STL is too small to contain a header and triangle count.");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const triangleCount = view.getUint32(80, true);
  const expectedBytes = 84 + triangleCount * 50;
  if (expectedBytes > buffer.byteLength) {
    throw new Error(`Binary STL triangle table is truncated (${buffer.byteLength} < ${expectedBytes}).`);
  }
  const bounds = createBounds();
  let vertexCount = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const base = 84 + triangle * 50 + 12;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const offset = base + vertex * 12;
      const point: [number, number, number] = [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)];
      if (!point.every(Number.isFinite)) throw new Error("Binary STL contains non-finite vertex coordinates.");
      vertexCount += 1;
      updateBounds(bounds, point);
    }
  }
  if (!vertexCount) throw new Error("Binary STL contains no triangles.");
  return {
    fileName,
    format: "stl-binary",
    byteLength: buffer.byteLength,
    vertexCount,
    faceCount: triangleCount,
    triangleCount,
    boundingBox: finalizeBounds(bounds)
  };
}

function createBounds(): { min: [number, number, number]; max: [number, number, number] } {
  return {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  };
}

function updateBounds(bounds: { min: [number, number, number]; max: [number, number, number] }, point: [number, number, number]): void {
  for (let index = 0; index < 3; index += 1) {
    bounds.min[index] = Math.min(bounds.min[index], point[index]);
    bounds.max[index] = Math.max(bounds.max[index], point[index]);
  }
}

function finalizeBounds(bounds: { min: [number, number, number]; max: [number, number, number] }): MeshSummary["boundingBox"] {
  if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) return undefined;
  return { min: bounds.min, max: bounds.max };
}

function toPoint(x: string | undefined, y: string | undefined, z: string | undefined): [number, number, number] | undefined {
  const point: [number, number, number] = [Number(x), Number(y), Number(z)];
  return point.every(Number.isFinite) ? point : undefined;
}
