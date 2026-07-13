import { describe, expect, it } from "vitest";
import { redactTraceText, safeTraceUrl, sanitizeTraceValue } from "./traceSanitizer.js";

describe("trace sanitizer secret boundaries", () => {
  it("fully removes Windows and Unix user paths containing spaces and non-ASCII characters", () => {
    const redacted = redactTraceText(
      "windows C:\\Users\\Alice Doe\\연구 (1)\\secret.txt\nunix /Users/jane doe/연구 (2)/secret.txt\nlinux /home/홍 길동/private/result.json"
    );

    expect(redacted).toContain("windows [path]");
    expect(redacted).toContain("unix [path]");
    expect(redacted).toContain("linux [path]");
    expect(redacted).not.toMatch(/Alice|Doe|jane|홍|길동|secret\.txt|result\.json/);
  });

  it("removes URL userinfo, fragments, signed credentials, auth codes, and secret-shaped values", () => {
    const sanitized = safeTraceUrl(
      "https://user:pass@example.com/a?page=2&X-Amz-Signature=top-secret-signature&sig=abcdef&auth=credential&code=oauth-code&value=sk-abcdefghijklmnop#private"
    );

    expect(sanitized).toContain("page=2");
    expect(sanitized).not.toMatch(/user|pass|private|top-secret-signature|abcdef|credential|oauth-code|sk-abcdefghijklmnop/);
    expect(sanitized.match(/%5Bredacted%5D/g)?.length).toBe(5);
  });

  it("applies the same URL policy to nested trace records", () => {
    const value = sanitizeTraceValue({ url: "https://example.com/a?credential=private-value&safe=yes" });

    expect(JSON.stringify(value)).not.toContain("private-value");
    expect(JSON.stringify(value)).toContain("safe=yes");
  });
});
