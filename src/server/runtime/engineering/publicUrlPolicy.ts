import type { PublicUrlPolicy as EngineeringPublicUrlPolicy } from "../../../core/tools/engineeringProgramTypes.js";
import { PublicUrlPolicy } from "../tools/publicUrlPolicy.js";

export function createDefaultPublicUrlPolicy(): EngineeringPublicUrlPolicy {
  const policy = new PublicUrlPolicy();
  return {
    async assertPublicUrl(value: string): Promise<void> {
      await policy.assertPublicHttpUrl(value);
    }
  };
}
