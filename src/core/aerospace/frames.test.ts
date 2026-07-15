import { describe, expect, it } from "vitest";
import {
  CoordinateFrameRegistry,
  addFramedVectors,
  quaternionToDcm,
  transformVector,
  type CoordinateFrameSpec,
  type FramedVector,
  type Matrix3
} from "./frames.js";

const identity: Matrix3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
];

describe("aerospace coordinate frames", () => {
  it("requires complete Euler and quaternion conventions", () => {
    const registry = new CoordinateFrameRegistry();
    expect(() => registry.register(frame("body", { representation: "euler", activeOrPassive: "active" }))).toThrow(/sequence/i);
    expect(() => registry.register(frame("sensor", { representation: "quaternion", activeOrPassive: "active" }))).toThrow(/ordering/i);
  });

  it("rejects NED/ENU or reference-point vector addition", () => {
    const ned = vector("ned");
    expect(() => addFramedVectors(ned, vector("enu"))).toThrow(/different frames/i);
    expect(() =>
      addFramedVectors({ ...ned, quantityKind: "moment", referencePointId: "cg" }, { ...ned, quantityKind: "moment", referencePointId: "nose" })
    ).toThrow(/reference point/i);
  });

  it("applies active and passive conventions explicitly and records round trip", () => {
    const rotation: Matrix3 = [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1]
    ];
    const active = transformVector({ vector: vector("body", [1, 0, 0]), from: frame("body"), to: frame("wind"), matrix: rotation });
    expect(active.vector.components).toEqual([0, 1, 0]);
    expect(active.receipt.roundTripError).toBe(0);
    const passive = transformVector({
      vector: vector("body", [1, 0, 0]),
      from: frame("body", { representation: "dcm", activeOrPassive: "passive" }),
      to: frame("wind", { representation: "dcm", activeOrPassive: "passive" }),
      matrix: rotation
    });
    expect(passive.vector.components).toEqual([0, -1, 0]);
  });

  it("requires the vector to match the source frame", () => {
    expect(() => transformVector({ vector: vector("ned"), from: frame("enu"), to: frame("body"), matrix: identity })).toThrow(/source frame/i);
  });

  it("rejects non-orthonormal matrices and preserves valid round trips", () => {
    expect(() =>
      transformVector({
        vector: vector("ned"),
        from: frame("ned"),
        to: frame("enu"),
        matrix: [
          [1, 0, 0],
          [0, 2, 0],
          [0, 0, 1]
        ]
      })
    ).toThrow(/orthonormal/i);
    const valid = transformVector({ vector: vector("ned", [2, -3, 4]), from: frame("ned"), to: frame("enu"), matrix: identity });
    expect(valid.vector.components).toEqual([2, -3, 4]);
  });

  it("requires transform determinant sign to match frame handedness", () => {
    const reflection: Matrix3 = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, -1]
    ];
    expect(() => transformVector({ vector: vector("body"), from: frame("body"), to: frame("wind"), matrix: reflection })).toThrow(/handedness/i);

    const leftHanded = { ...frame("sensor"), handedness: "left" as const };
    const crossHanded = transformVector({ vector: vector("body"), from: frame("body"), to: leftHanded, matrix: reflection });
    expect(crossHanded.receipt.determinant).toBe(-1);
    expect(() => transformVector({ vector: vector("body"), from: frame("body"), to: leftHanded, matrix: identity })).toThrow(/handedness/i);
  });

  it("honors explicit quaternion ordering", () => {
    const wxyz = quaternionToDcm([Math.SQRT1_2, 0, 0, Math.SQRT1_2], "wxyz");
    const xyzw = quaternionToDcm([0, 0, Math.SQRT1_2, Math.SQRT1_2], "xyzw");
    expect(wxyz).toEqual(xyzw);
    expect(quaternionToDcm([1, 0, 0, 0], "wxyz")).toEqual(identity);
  });

  it("maintains registry revision and parent integrity", () => {
    const registry = new CoordinateFrameRegistry();
    registry.register(frame("ecef"));
    registry.register({ ...frame("ned"), parentFrameId: "ecef" });
    expect(registry.list().map((item) => item.id)).toEqual(["ecef", "ned"]);
    expect(() => registry.register(frame("ned"))).toThrow(/revision must increase/i);
    expect(() => registry.register({ ...frame("sensor"), parentFrameId: "missing" })).toThrow(/parent frame/i);
  });
});

function frame(
  id: string,
  rotationConvention: CoordinateFrameSpec["rotationConvention"] = { representation: "dcm", activeOrPassive: "active" }
): CoordinateFrameSpec {
  return {
    id,
    name: id.toUpperCase(),
    kind: id === "body" ? "body" : id === "wind" ? "wind" : "local_navigation",
    handedness: "right",
    axes: [
      { axis: "x", positiveDirection: id === "ned" ? "north" : "forward/east" },
      { axis: "y", positiveDirection: id === "ned" ? "east" : "right/north" },
      { axis: "z", positiveDirection: id === "enu" ? "up" : "down" }
    ],
    origin: { description: "fixture origin" },
    rotationConvention,
    sourceEvidenceIds: ["frame-convention-source"],
    revision: 1
  };
}

function vector(frameId: string, components: readonly [number, number, number] = [1, 2, 3]): FramedVector {
  return { frameId, components, quantityKind: "velocity", unit: "m/s" };
}
