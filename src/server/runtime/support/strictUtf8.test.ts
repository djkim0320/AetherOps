import { describe, expect, it } from "vitest";
import { decodeStrictUtf8, decodeStrictUtf8Chunks } from "./strictUtf8.js";

describe("strict UTF-8 decoding", () => {
  it("preserves Korean text when bytes are valid UTF-8", () => {
    const text = "한글 질문: Vector RAG와 Hybrid RAG의 근거 추적성 차이를 검증한다.";

    expect(decodeStrictUtf8(Buffer.from(text, "utf8"))).toBe(text);
  });

  it("rejects invalid UTF-8 byte sequences", () => {
    expect(() => decodeStrictUtf8(Buffer.from([0xff]), "invalid payload")).toThrow("invalid payload is not valid UTF-8");
  });

  it("rejects already-decoded replacement characters", () => {
    expect(() => decodeStrictUtf8(Buffer.from("bad \uFFFD text", "utf8"), "replacement payload")).toThrow(
      "replacement payload contains Unicode replacement characters"
    );
  });

  it("decodes split chunks with the same strict policy", () => {
    const text = "설정 부족 시 blocked 상태와 RunAuditOutput 생성 여부 확인";
    const bytes = Buffer.from(text, "utf8");

    expect(decodeStrictUtf8Chunks([bytes.subarray(0, 5), bytes.subarray(5)], "chunked payload")).toBe(text);
  });
});
