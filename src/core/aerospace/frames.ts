export type FrameKind = "inertial" | "earth_fixed" | "local_navigation" | "body" | "stability" | "wind" | "sensor" | "structural" | "custom";

export interface AxisDefinition {
  axis: "x" | "y" | "z";
  positiveDirection: string;
}

export interface CoordinateFrameSpec {
  id: string;
  name: string;
  kind: FrameKind;
  handedness: "right" | "left";
  axes: readonly AxisDefinition[];
  origin: { description: string; referenceArtifactId?: string };
  parentFrameId?: string;
  rotationConvention?: {
    representation: "dcm" | "quaternion" | "euler";
    sequence?: string;
    activeOrPassive: "active" | "passive";
    quaternionOrdering?: "wxyz" | "xyzw";
  };
  epoch?: string;
  sourceEvidenceIds: readonly string[];
  revision: number;
}

export interface FramedVector {
  components: readonly [number, number, number];
  frameId: string;
  quantityKind: "force" | "moment" | "velocity" | "angular_rate" | "position" | "generic";
  unit: string;
  referencePointId?: string;
}

export type Matrix3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

export interface FrameTransformReceipt {
  fromFrameId: string;
  toFrameId: string;
  convention: "active" | "passive";
  matrix: Matrix3;
  determinant: number;
  orthonormalError: number;
  roundTripError: number;
}

export class CoordinateFrameRegistry {
  private readonly frames = new Map<string, CoordinateFrameSpec>();

  register(frame: CoordinateFrameSpec): void {
    validateFrame(frame);
    const existing = this.frames.get(frame.id);
    if (existing && existing.revision >= frame.revision) throw new Error(`Frame revision must increase for ${frame.id}.`);
    if (frame.parentFrameId && !this.frames.has(frame.parentFrameId)) throw new Error(`Parent frame is not registered: ${frame.parentFrameId}.`);
    this.frames.set(frame.id, deepFreezeFrame(frame));
  }

  get(id: string): CoordinateFrameSpec {
    const frame = this.frames.get(id);
    if (!frame) throw new Error(`Coordinate frame is not registered: ${id}.`);
    return frame;
  }

  list(): readonly CoordinateFrameSpec[] {
    return [...this.frames.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

export function addFramedVectors(left: FramedVector, right: FramedVector): FramedVector {
  if (left.frameId !== right.frameId) throw new Error(`Cannot add vectors in different frames: ${left.frameId} and ${right.frameId}.`);
  if (left.quantityKind !== right.quantityKind || left.unit !== right.unit || left.referencePointId !== right.referencePointId) {
    throw new Error("Vector kind, unit and reference point must match before addition.");
  }
  return Object.freeze({ ...left, components: mapComponents(left.components, right.components, (a, b) => a + b) });
}

export function transformVector(input: { vector: FramedVector; from: CoordinateFrameSpec; to: CoordinateFrameSpec; matrix: Matrix3; tolerance?: number }): {
  vector: FramedVector;
  receipt: FrameTransformReceipt;
} {
  if (input.vector.frameId !== input.from.id) throw new Error("Vector frame does not match transform source frame.");
  const convention = input.to.rotationConvention?.activeOrPassive ?? input.from.rotationConvention?.activeOrPassive;
  if (!convention) throw new Error("Frame transform requires an explicit active/passive convention.");
  const tolerance = input.tolerance ?? 1e-10;
  const orthonormalError = matrixOrthonormalError(input.matrix);
  if (orthonormalError > tolerance) throw new Error(`Frame transform matrix is not orthonormal; error=${orthonormalError}.`);
  const determinant = determinant3(input.matrix);
  const expectedMagnitude = 1;
  if (Math.abs(Math.abs(determinant) - expectedMagnitude) > tolerance) throw new Error(`Frame transform determinant is invalid: ${determinant}.`);
  const applied = convention === "active" ? input.matrix : transpose3(input.matrix);
  const output = multiplyMatrixVector(applied, input.vector.components);
  const recovered = multiplyMatrixVector(transpose3(applied), output);
  const roundTripError = norm(mapComponents(recovered, input.vector.components, (a, b) => a - b));
  if (roundTripError > tolerance * Math.max(1, norm(input.vector.components))) throw new Error(`Frame transform round-trip failed: ${roundTripError}.`);
  return {
    vector: Object.freeze({ ...input.vector, frameId: input.to.id, components: output }),
    receipt: Object.freeze({
      fromFrameId: input.from.id,
      toFrameId: input.to.id,
      convention,
      matrix: input.matrix,
      determinant,
      orthonormalError,
      roundTripError
    })
  };
}

export function quaternionToDcm(quaternion: readonly [number, number, number, number], ordering: "wxyz" | "xyzw"): Matrix3 {
  const [w, x, y, z] = ordering === "wxyz" ? quaternion : [quaternion[3], quaternion[0], quaternion[1], quaternion[2]];
  const magnitude = Math.hypot(w, x, y, z);
  if (!Number.isFinite(magnitude) || magnitude < 1e-15) throw new Error("Quaternion must be finite and nonzero.");
  const [nw, nx, ny, nz] = [w / magnitude, x / magnitude, y / magnitude, z / magnitude];
  return [
    [1 - 2 * (ny * ny + nz * nz), 2 * (nx * ny - nz * nw), 2 * (nx * nz + ny * nw)],
    [2 * (nx * ny + nz * nw), 1 - 2 * (nx * nx + nz * nz), 2 * (ny * nz - nx * nw)],
    [2 * (nx * nz - ny * nw), 2 * (ny * nz + nx * nw), 1 - 2 * (nx * nx + ny * ny)]
  ];
}

function validateFrame(frame: CoordinateFrameSpec): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(frame.id)) throw new Error("Frame id is invalid.");
  if (!frame.name.trim() || !frame.origin.description.trim()) throw new Error("Frame name and origin are required.");
  if (!Number.isSafeInteger(frame.revision) || frame.revision < 1) throw new Error("Frame revision must be a positive integer.");
  if (frame.axes.length !== 3 || new Set(frame.axes.map((axis) => axis.axis)).size !== 3 || frame.axes.some((axis) => !axis.positiveDirection.trim())) {
    throw new Error("Frame must define unique x, y and z positive axes.");
  }
  const convention = frame.rotationConvention;
  if (convention?.representation === "euler" && !convention.sequence) throw new Error("Euler frames require an explicit rotation sequence.");
  if (convention?.representation === "quaternion" && !convention.quaternionOrdering) throw new Error("Quaternion frames require an explicit ordering.");
}

function deepFreezeFrame(frame: CoordinateFrameSpec): CoordinateFrameSpec {
  return Object.freeze({
    ...frame,
    axes: Object.freeze(frame.axes.map((axis) => Object.freeze({ ...axis }))),
    sourceEvidenceIds: Object.freeze([...frame.sourceEvidenceIds])
  });
}

function multiplyMatrixVector(matrix: Matrix3, vector: readonly [number, number, number]): readonly [number, number, number] {
  return matrix.map((row) => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]) as unknown as readonly [number, number, number];
}

function transpose3(matrix: Matrix3): Matrix3 {
  return [
    [matrix[0][0], matrix[1][0], matrix[2][0]],
    [matrix[0][1], matrix[1][1], matrix[2][1]],
    [matrix[0][2], matrix[1][2], matrix[2][2]]
  ];
}

function determinant3(m: Matrix3): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

function matrixOrthonormalError(matrix: Matrix3): number {
  const product = multiplyMatrices(matrix, transpose3(matrix));
  return Math.max(...product.flatMap((row, i) => row.map((value, j) => Math.abs(value - (i === j ? 1 : 0)))));
}

function multiplyMatrices(left: Matrix3, right: Matrix3): Matrix3 {
  return left.map((row) => right[0].map((_, j) => row.reduce((sum, value, k) => sum + value * right[k][j], 0))) as unknown as Matrix3;
}

function mapComponents(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
  operation: (left: number, right: number) => number
): readonly [number, number, number] {
  return [operation(left[0], right[0]), operation(left[1], right[1]), operation(left[2], right[2])];
}

function norm(value: readonly number[]): number {
  return Math.hypot(...value);
}
