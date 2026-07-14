import type { SourceAccessPolicy } from "../../../contracts/api-v2/jobs.js";
import { PublicUrlPolicy } from "../../runtime/tools/publicUrlPolicy.js";
import { RpcValidationError } from "./rpcErrors.js";

export async function validateSourcePolicy(policy: SourceAccessPolicy): Promise<SourceAccessPolicy> {
  if (policy.mode === "offline") return { mode: "offline" };
  if (policy.mode === "discovery") return { mode: "discovery", allowedDomains: [...policy.allowedDomains] };
  const validator = new PublicUrlPolicy({ forbidQuery: true });
  const urls: string[] = [];
  for (const [urlIndex, url] of policy.urls.entries()) {
    try {
      urls.push(await validator.assertPublicHttpUrl(url));
    } catch (error) {
      throw new RpcValidationError("A source allowlist URL is not publicly reachable.", {
        urlIndex,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { mode: "allowlist", urls };
}
