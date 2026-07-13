import { describe, expect, it } from "vitest";
import { assertDurablePayload } from "./durablePayload.js";

describe("durable payload", () => {
  it("accepts plain finite JSON values", () => {
    expect(() => assertDurablePayload({ action: "start", count: 2, flags: [true, null] })).not.toThrow();
  });

  it.each([undefined, () => undefined, 1n, Number.NaN, new Date()])("rejects a nested non-JSON value: %s", (value) => {
    expect(() => assertDurablePayload({ value })).toThrow(/payload/);
  });

  it("rejects cyclic input before writing a job", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => assertDurablePayload(value)).toThrow(/cycle/);
  });
});
