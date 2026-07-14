import { describe, expect, it } from "vitest";
import { validateSourcePolicy } from "./rpcSourcePolicy.js";

describe("RPC source policy validation", () => {
  it("returns the public canonical URL that is safe to persist", async () => {
    await expect(validateSourcePolicy({ mode: "allowlist", urls: [" HTTPS://93.184.216.34:443/source#local-fragment "] })).resolves.toEqual({
      mode: "allowlist",
      urls: ["https://93.184.216.34/source"]
    });
  });

  it.each(["https://user:password@93.184.216.34/source", "https://93.184.216.34/source?token=do-not-store", "https://93.184.216.34/source?id=public"])(
    "rejects plaintext-sensitive allowlist URL state without echoing it",
    async (url) => {
      const error = await validateSourcePolicy({ mode: "allowlist", urls: [url] }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain(url);
      expect(JSON.stringify(error)).not.toContain("password");
      expect(JSON.stringify(error)).not.toContain("do-not-store");
    }
  );
});
