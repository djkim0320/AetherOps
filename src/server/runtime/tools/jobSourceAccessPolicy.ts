import type { ResearchSourceAccessPolicy } from "../../../core/shared/adapterTypes.js";
import { assertSourceAccess } from "../../../core/tools/sourceAccessPolicy.js";
import type { PublicHttpUrlPolicy } from "./boundedHttpClient.js";
import { PublicUrlPolicy } from "./publicUrlPolicy.js";

export class JobSourceAccessPolicy implements PublicHttpUrlPolicy {
  constructor(
    private readonly sourceAccess: ResearchSourceAccessPolicy,
    private readonly publicUrlPolicy: PublicHttpUrlPolicy = new PublicUrlPolicy()
  ) {}

  async assertPublicHttpUrl(value: string): Promise<string> {
    const publicUrl = await this.publicUrlPolicy.assertPublicHttpUrl(value);
    return assertSourceAccess(this.sourceAccess, publicUrl);
  }

  async resolvePublicHostAddresses(hostname: string): Promise<string[]> {
    if (!this.publicUrlPolicy.resolvePublicHostAddresses) {
      throw new Error("Public URL policy does not support connect-time address verification.");
    }
    return this.publicUrlPolicy.resolvePublicHostAddresses(hostname);
  }
}
