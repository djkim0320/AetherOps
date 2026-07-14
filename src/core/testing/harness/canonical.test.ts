import { describe, expect, it } from "vitest";
import { hashCanonical, hashCanonicalSync, serializeCanonical } from "./public.js";

describe("canonical harness hashing", () => {
  it("matches the known SHA-256 vector with canonical key ordering", async () => {
    const value = { b: 2, a: 1 };
    const expected = "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777";

    expect(serializeCanonical(value)).toBe('{"a":1,"b":2}');
    expect(hashCanonicalSync(value)).toBe(expected);
    await expect(hashCanonical(value)).resolves.toBe(expected);
  });

  it("rejects unsupported and cyclic values instead of silently dropping them", () => {
    expect(() => serializeCanonical({ unsupported: undefined })).toThrow(/unsupported value type/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => serializeCanonical(cyclic)).toThrow(/cyclic/);
  });
});
